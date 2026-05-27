/**
 * BigQuery SQL tokenizer.
 *
 * Walks an input string and emits a flat list of tokens. The translator
 * (BL-014) consumes this list — it doesn't parse SQL grammatically; it
 * rewrites a fixed set of BQ-isms into DuckDB SQL. The tokenizer's job
 * is to make sure rewriting doesn't accidentally touch identifiers
 * that live inside strings, comments, or backticks.
 *
 * Token kinds:
 *   - `whitespace`            spaces/tabs/newlines
 *   - `line-comment`          `-- ...` to end of line
 *   - `block-comment`         `/* ... *​/`
 *   - `string`                `'...'` or `"..."` (with `\` escapes)
 *   - `raw-string`            `r'...'` / `r"..."` (no escapes)
 *   - `bytes`                 `b'...'` / `b"..."`
 *   - `raw-bytes`             `rb'...'` / `br'...'`
 *   - `backtick-identifier`   `` `proj.dataset.table` ``
 *   - `number`                `42`, `3.14`, `1.5e-3`
 *   - `parameter`             `@name` or `@_2`
 *   - `identifier`            `foo`, `_bar` (keywords are not distinguished)
 *   - `operator`              `+ - * / % = != <> <= >= < > || && :: !` etc.
 *   - `punctuation`           `( ) , ; . [ ] { }`
 *
 * Triple-quoted strings, hex literals, and other BQ-exotic syntax are
 * intentionally out of scope for v0 — the translator only touches the
 * idioms drops-event-ingestion uses, which don't include them.
 */

export type TokenKind =
  | 'whitespace'
  | 'line-comment'
  | 'block-comment'
  | 'string'
  | 'raw-string'
  | 'bytes'
  | 'raw-bytes'
  | 'backtick-identifier'
  | 'number'
  | 'parameter'
  | 'identifier'
  | 'operator'
  | 'punctuation';

export interface Token {
  readonly kind: TokenKind;
  /** Raw text from the input, including any surrounding quotes / backticks. */
  readonly value: string;
  /** Character offset at which the token starts (0-based, inclusive). */
  readonly start: number;
  /** Character offset just past the end of the token (exclusive). */
  readonly end: number;
}

export class TokenizeError extends Error {
  public readonly offset: number;
  constructor(message: string, offset: number) {
    super(`${message} (at offset ${offset})`);
    this.name = 'TokenizeError';
    this.offset = offset;
  }
}

// ---------------------------------------------------------------------------
// Character classes
// ---------------------------------------------------------------------------

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_';
}

function isIdentCont(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

const MULTI_CHAR_OPS: readonly string[] = ['!=', '<>', '<=', '>=', '==', '||', '&&', '::'];
const PUNCTUATION = new Set(['(', ')', ',', ';', '.', '[', ']', '{', '}']);
// `~` is bitwise NOT in both BQ and DuckDB. `^` is XOR in BQ but
// exponentiation in DuckDB — we tokenize it but the semantic divergence
// is documented (use `xor(a, b)` for XOR). The shift forms `<<` / `>>`
// are tokenized as two `<` / `>` operators each (the join is by string
// concat in the output), which is why they don't need entries here.
const SINGLE_OPS = new Set(['+', '-', '*', '/', '%', '=', '<', '>', '!', '|', '&', '~', '^']);

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function tokenize(sql: string): readonly Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    i = readToken(sql, i, tokens);
  }
  return tokens;
}

function readToken(sql: string, start: number, out: Token[]): number {
  const ch = sql.charAt(start);

  if (isWhitespace(ch)) return readWhitespace(sql, start, out);
  if (ch === '-' && sql.charAt(start + 1) === '-') return readLineComment(sql, start, out);
  if (ch === '/' && sql.charAt(start + 1) === '*') return readBlockComment(sql, start, out);
  if (ch === '`') return readBacktickIdent(sql, start, out);
  if (ch === "'" || ch === '"') {
    if (sql.charAt(start + 1) === ch && sql.charAt(start + 2) === ch) {
      return readTripleQuotedString(sql, start, 'string', start, out);
    }
    return readQuotedString(sql, start, 'string', start, true, out);
  }
  if (ch === '@') return readParameter(sql, start, out);
  if (ch === '$' && isDigit(sql.charAt(start + 1))) {
    return readPositionalParameter(sql, start, out);
  }
  if (ch === '?') {
    // BQ's positional placeholder for `EXECUTE IMMEDIATE … USING …`. We
    // emit it as an operator so the script interpreter can rewrite it
    // to a `$N` placeholder bound to the matching USING value.
    out.push({ kind: 'operator', value: '?', start, end: start + 1 });
    return start + 1;
  }

  // r / b / rb / br string prefixes (case-insensitive).
  const prefixEnd = readStringPrefix(sql, start);
  if (prefixEnd !== null) {
    const quoteChar = sql.charAt(prefixEnd);
    if (quoteChar === "'" || quoteChar === '"') {
      const kind = stringKindForPrefix(sql.slice(start, prefixEnd));
      const allowEscapes = kind === 'string' || kind === 'bytes';
      if (sql.charAt(prefixEnd + 1) === quoteChar && sql.charAt(prefixEnd + 2) === quoteChar) {
        return readTripleQuotedString(sql, prefixEnd, kind, start, out);
      }
      return readQuotedString(sql, prefixEnd, kind, start, allowEscapes, out);
    }
  }

  if (isDigit(ch) || (ch === '.' && isDigit(sql.charAt(start + 1)))) {
    return readNumber(sql, start, out);
  }
  if (isIdentStart(ch)) return readIdentifier(sql, start, out);

  // Multi-char operator.
  const two = sql.slice(start, start + 2);
  if (MULTI_CHAR_OPS.includes(two)) {
    out.push({ kind: 'operator', value: two, start, end: start + 2 });
    return start + 2;
  }

  if (PUNCTUATION.has(ch)) {
    out.push({ kind: 'punctuation', value: ch, start, end: start + 1 });
    return start + 1;
  }
  if (SINGLE_OPS.has(ch)) {
    out.push({ kind: 'operator', value: ch, start, end: start + 1 });
    return start + 1;
  }

  throw new TokenizeError(`Unexpected character "${ch}"`, start);
}

// ---------------------------------------------------------------------------
// Per-kind readers
// ---------------------------------------------------------------------------

function readWhitespace(sql: string, start: number, out: Token[]): number {
  let i = start + 1;
  while (i < sql.length && isWhitespace(sql.charAt(i))) i += 1;
  out.push({ kind: 'whitespace', value: sql.slice(start, i), start, end: i });
  return i;
}

function readLineComment(sql: string, start: number, out: Token[]): number {
  let i = start + 2;
  while (i < sql.length && sql.charAt(i) !== '\n') i += 1;
  out.push({ kind: 'line-comment', value: sql.slice(start, i), start, end: i });
  return i;
}

function readBlockComment(sql: string, start: number, out: Token[]): number {
  let i = start + 2;
  while (i < sql.length - 1) {
    if (sql.charAt(i) === '*' && sql.charAt(i + 1) === '/') {
      i += 2;
      out.push({ kind: 'block-comment', value: sql.slice(start, i), start, end: i });
      return i;
    }
    i += 1;
  }
  throw new TokenizeError('Unterminated block comment', start);
}

function readBacktickIdent(sql: string, start: number, out: Token[]): number {
  let i = start + 1;
  while (i < sql.length && sql.charAt(i) !== '`') i += 1;
  if (i >= sql.length) {
    throw new TokenizeError('Unterminated backtick identifier', start);
  }
  i += 1; // consume closing backtick
  out.push({ kind: 'backtick-identifier', value: sql.slice(start, i), start, end: i });
  return i;
}

function readQuotedString(
  sql: string,
  contentStart: number,
  kind: TokenKind,
  tokenStart: number,
  allowEscapes: boolean,
  out: Token[],
): number {
  const quote = sql.charAt(contentStart);
  let i = contentStart + 1;
  while (i < sql.length) {
    const c = sql.charAt(i);
    if (allowEscapes && c === '\\') {
      // Skip the next character (could be quote, newline, etc.).
      if (i + 1 >= sql.length) {
        throw new TokenizeError('Unterminated escape sequence', i);
      }
      i += 2;
      continue;
    }
    if (c === quote) {
      i += 1;
      out.push({ kind, value: sql.slice(tokenStart, i), start: tokenStart, end: i });
      return i;
    }
    if (c === '\n') {
      throw new TokenizeError('Unterminated string', tokenStart);
    }
    i += 1;
  }
  throw new TokenizeError('Unterminated string', tokenStart);
}

/**
 * BQ triple-quoted strings: `"""..."""` and `'''...'''`. Can span newlines.
 * Internal single/double quotes don't terminate; only a triple sequence of
 * the same quote char closes the string. No escape handling — DuckDB
 * preserves backslashes verbatim, which matches BQ's raw triple-string
 * behavior for the SQL UDF / JS UDF bodies that primarily use this form.
 */
function readTripleQuotedString(
  sql: string,
  contentStart: number,
  kind: TokenKind,
  tokenStart: number,
  out: Token[],
): number {
  const quote = sql.charAt(contentStart);
  // Skip the opening `"""` or `'''`.
  let i = contentStart + 3;
  while (i < sql.length - 2) {
    if (sql.charAt(i) === quote && sql.charAt(i + 1) === quote && sql.charAt(i + 2) === quote) {
      i += 3;
      out.push({ kind, value: sql.slice(tokenStart, i), start: tokenStart, end: i });
      return i;
    }
    i += 1;
  }
  throw new TokenizeError('Unterminated triple-quoted string', tokenStart);
}

/** `$N` positional placeholder. Generated by the translator from `@name`
 *  refs, and used internally by the script interpreter to bind script-local
 *  variables. We re-tokenize translator output during scripting, so the
 *  tokenizer needs to accept this form. */
function readPositionalParameter(sql: string, start: number, out: Token[]): number {
  let i = start + 1;
  while (i < sql.length && isDigit(sql.charAt(i))) i += 1;
  out.push({ kind: 'parameter', value: sql.slice(start, i), start, end: i });
  return i;
}

function readParameter(sql: string, start: number, out: Token[]): number {
  let i = start + 1;
  while (i < sql.length && isIdentCont(sql.charAt(i))) i += 1;
  if (i === start + 1) {
    throw new TokenizeError('Parameter name expected after "@"', start);
  }
  out.push({ kind: 'parameter', value: sql.slice(start, i), start, end: i });
  return i;
}

function readNumber(sql: string, start: number, out: Token[]): number {
  let i = start;
  // Integer part (or leading .).
  while (i < sql.length && isDigit(sql.charAt(i))) i += 1;
  // Fractional.
  if (sql.charAt(i) === '.') {
    i += 1;
    while (i < sql.length && isDigit(sql.charAt(i))) i += 1;
  }
  // Exponent.
  if (sql.charAt(i) === 'e' || sql.charAt(i) === 'E') {
    i += 1;
    if (sql.charAt(i) === '+' || sql.charAt(i) === '-') i += 1;
    if (!isDigit(sql.charAt(i))) {
      throw new TokenizeError('Number exponent requires digits', start);
    }
    while (i < sql.length && isDigit(sql.charAt(i))) i += 1;
  }
  out.push({ kind: 'number', value: sql.slice(start, i), start, end: i });
  return i;
}

function readIdentifier(sql: string, start: number, out: Token[]): number {
  let i = start + 1;
  while (i < sql.length && isIdentCont(sql.charAt(i))) i += 1;
  out.push({ kind: 'identifier', value: sql.slice(start, i), start, end: i });
  return i;
}

// ---------------------------------------------------------------------------
// String prefix helpers
// ---------------------------------------------------------------------------

function readStringPrefix(sql: string, start: number): number | null {
  // r, b (1-char) or rb, br (2-char).
  const c1 = sql.charAt(start);
  const c2 = sql.charAt(start + 1);
  if (!isStringPrefixChar(c1)) return null;
  if (isStringPrefixChar(c2) && c2.toLowerCase() !== c1.toLowerCase()) {
    return start + 2;
  }
  return start + 1;
}

function isStringPrefixChar(ch: string): boolean {
  return ch === 'r' || ch === 'R' || ch === 'b' || ch === 'B';
}

function stringKindForPrefix(prefix: string): TokenKind {
  const lower = prefix.toLowerCase();
  if (lower === 'r') return 'raw-string';
  if (lower === 'b') return 'bytes';
  if (lower === 'rb' || lower === 'br') return 'raw-bytes';
  // Unreachable: prefix was validated by readStringPrefix.
  /* node:coverage ignore next */
  throw new TokenizeError(`Unknown string prefix "${prefix}"`, 0);
}

// ---------------------------------------------------------------------------
// Token-array walking helpers (shared by the translator and DDL parser)
// ---------------------------------------------------------------------------

export function isSkippable(tok: Token): boolean {
  return tok.kind === 'whitespace' || tok.kind === 'line-comment' || tok.kind === 'block-comment';
}

/** Index of the first non-skippable token at or after `start`. */
export function nextNonSkippable(tokens: readonly Token[], start: number): number {
  let i = start;
  while (i < tokens.length && isSkippable(tokens[i] as Token)) i += 1;
  return i;
}

/** Concatenate the raw text of tokens in `[startIdx, endIdx)`. */
export function sliceTokens(tokens: readonly Token[], startIdx: number, endIdx: number): string {
  let out = '';
  for (let j = startIdx; j < endIdx; j += 1) {
    const t = tokens[j];
    if (t === undefined) continue;
    out += t.value;
  }
  return out;
}
