import { BqError } from '../../util/errors.ts';
import { type Token, sliceTokens } from '../tokenize.ts';
import type { RewriteCtx } from './context.ts';

// ---------------------------------------------------------------------------
// Pure token-walking helpers (no translation)
// ---------------------------------------------------------------------------

/** Index of the first non-whitespace token in `[start, end)`, or null. */
export function skipWhitespace(
  tokens: readonly Token[],
  start: number,
  end: number,
): number | null {
  for (let j = start; j < end; j += 1) {
    const t = tokens[j];
    if (t === undefined) return null;
    if (t.kind !== 'whitespace' && t.kind !== 'line-comment' && t.kind !== 'block-comment') {
      return j;
    }
  }
  return null;
}

/** Index of the next token if it's `(`, else null. */
export function findFollowingOpenParen(
  tokens: readonly Token[],
  start: number,
  end: number,
): number | null {
  const idx = skipWhitespace(tokens, start, end);
  if (idx === null) return null;
  const t = tokens[idx];
  if (t === undefined) return null;
  if (t.kind === 'punctuation' && t.value === '(') return idx;
  return null;
}

/** Index of the `)` matching the `(` at `openIdx`. Throws if unbalanced. */
export function findMatchingClose(tokens: readonly Token[], openIdx: number, end: number): number {
  let depth = 0;
  for (let j = openIdx; j < end; j += 1) {
    const t = tokens[j];
    if (t === undefined) continue;
    if (t.kind === 'punctuation' && t.value === '(') depth += 1;
    else if (t.kind === 'punctuation' && t.value === ')') {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  throw BqError.invalid('Unbalanced parentheses in SQL.', 'sql');
}

/** Index of the first top-level `,` in `[start, closeIdx)`, or null. Commas
 * inside any nested bracket — `()`, `[]` (array literals), `{}` (structs) —
 * are not top-level. */
export function findTopLevelComma(
  tokens: readonly Token[],
  start: number,
  closeIdx: number,
): number | null {
  let depth = 0;
  for (let j = start; j < closeIdx; j += 1) {
    const t = tokens[j];
    if (t === undefined) continue;
    if (t.kind === 'punctuation' && (t.value === '(' || t.value === '[' || t.value === '{')) {
      depth += 1;
    } else if (
      t.kind === 'punctuation' &&
      (t.value === ')' || t.value === ']' || t.value === '}')
    ) {
      depth -= 1;
    } else if (t.kind === 'punctuation' && t.value === ',' && depth === 0) {
      return j;
    }
  }
  return null;
}

export function areArgsEmpty(tokens: readonly Token[], openIdx: number, closeIdx: number): boolean {
  for (let j = openIdx + 1; j < closeIdx; j += 1) {
    const t = tokens[j];
    if (t === undefined) continue;
    if (t.kind !== 'whitespace' && t.kind !== 'line-comment' && t.kind !== 'block-comment') {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// String-literal codecs
// ---------------------------------------------------------------------------

/** Decode a BQ (non-raw) string literal — strip the `'`/`"`/`'''`/`"""`
 * delimiter and interpret BQ backslash escapes. */
export function decodeBqString(raw: string): string {
  let body: string;
  if (
    (raw.startsWith('"""') && raw.endsWith('"""')) ||
    (raw.startsWith("'''") && raw.endsWith("'''"))
  ) {
    body = raw.slice(3, -3);
  } else {
    body = raw.slice(1, -1);
  }
  let result = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== '\\') {
      result += ch;
      continue;
    }
    const next = body[i + 1];
    switch (next) {
      case 'n':
        result += '\n';
        i += 1;
        break;
      case 't':
        result += '\t';
        i += 1;
        break;
      case 'r':
        result += '\r';
        i += 1;
        break;
      case 'b':
        result += '\b';
        i += 1;
        break;
      case 'f':
        result += '\f';
        i += 1;
        break;
      case 'v':
        result += '\v';
        i += 1;
        break;
      case 'a':
        result += '\x07';
        i += 1;
        break;
      case '0':
      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
      case '6':
      case '7': {
        const m = /^[0-7]{1,3}/.exec(body.slice(i + 1));
        const oct = m ? m[0] : '';
        result += String.fromCharCode(Number.parseInt(oct, 8));
        i += oct.length;
        break;
      }
      case 'x':
      case 'X': {
        const m = /^[0-9a-fA-F]{2}/.exec(body.slice(i + 2));
        if (m) {
          result += String.fromCharCode(Number.parseInt(m[0], 16));
          i += 1 + m[0].length;
        } else {
          result += next;
          i += 1;
        }
        break;
      }
      case 'u': {
        const m = /^[0-9a-fA-F]{4}/.exec(body.slice(i + 2));
        if (m) {
          result += String.fromCharCode(Number.parseInt(m[0], 16));
          i += 1 + m[0].length;
        } else {
          result += next;
          i += 1;
        }
        break;
      }
      case 'U': {
        const m = /^[0-9a-fA-F]{8}/.exec(body.slice(i + 2));
        if (m) {
          result += String.fromCodePoint(Number.parseInt(m[0], 16));
          i += 1 + m[0].length;
        } else {
          result += next;
          i += 1;
        }
        break;
      }
      case undefined:
        result += '\\';
        break;
      default:
        result += next;
        i += 1;
        break;
    }
  }
  return result;
}

/** Encode a value as a DuckDB single-quoted literal (doubling `'`). */
export function encodeDuckString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function extractStringLiteral(tok: Token | undefined): string | null {
  if (tok === undefined) return null;
  if (tok.kind === 'string') return decodeBqString(tok.value);
  if (tok.kind === 'raw-string') return tok.value.replace(/^[rR]/, '').slice(1, -1);
  return null;
}

export function hasCaptureGroup(pattern: string): boolean {
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '[') {
      i += 1;
      while (i < pattern.length && pattern[i] !== ']') {
        if (pattern[i] === '\\') i += 2;
        else i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === '(' && pattern[i + 1] !== '?') return true;
    i += 1;
  }
  return false;
}

/** Parse `WITH OFFSET [AS <name>]` starting at `withIdx`. Returns the offset
 * column name and the index just past the clause, or null. */
export function parseWithOffset(
  tokens: readonly Token[],
  withIdx: number,
  endIdx: number,
): { name: string; nextIdx: number } | null {
  const withTok = tokens[withIdx];
  if (withTok?.kind !== 'identifier' || withTok.value.toUpperCase() !== 'WITH') return null;
  const offIdx = skipWhitespace(tokens, withIdx + 1, endIdx);
  const offTok = offIdx !== null ? tokens[offIdx] : undefined;
  if (offTok?.kind !== 'identifier' || offTok.value.toUpperCase() !== 'OFFSET' || offIdx === null) {
    return null;
  }
  let name = 'offset';
  let nextIdx = offIdx + 1;
  const asIdx = skipWhitespace(tokens, offIdx + 1, endIdx);
  const asTok = asIdx !== null ? tokens[asIdx] : undefined;
  if (asTok?.kind === 'identifier' && asTok.value.toUpperCase() === 'AS' && asIdx !== null) {
    const nameIdx = skipWhitespace(tokens, asIdx + 1, endIdx);
    const nameTok = nameIdx !== null ? tokens[nameIdx] : undefined;
    if (
      (nameTok?.kind === 'identifier' || nameTok?.kind === 'backtick-identifier') &&
      nameIdx !== null
    ) {
      name = nameTok.kind === 'backtick-identifier' ? nameTok.value.slice(1, -1) : nameTok.value;
      nextIdx = nameIdx + 1;
    }
  }
  return { name, nextIdx };
}

/**
 * Parse a `STRUCT(<expr> AS <name>, ...)` argument list. Returns
 * `[{name, expr}, ...]` when every comma-separated argument ends with
 * `AS <identifier>`, else null (caller falls back to positional).
 */
export function tryParseStructNamedArgs(
  ctx: RewriteCtx,
  start: number,
  closeIdx: number,
): ReadonlyArray<{ readonly name: string; readonly expr: string }> | null {
  const { tokens, tr } = ctx;
  if (areArgsEmpty(tokens, start - 1, closeIdx)) return null;
  const out: Array<{ name: string; expr: string }> = [];
  let argStart = start;
  while (argStart < closeIdx) {
    const commaIdx = findTopLevelComma(tokens, argStart, closeIdx);
    const argEnd = commaIdx === null ? closeIdx : commaIdx;
    let lastTokIdx: number | null = null;
    let prevTokIdx: number | null = null;
    for (let j = argEnd - 1; j >= argStart; j -= 1) {
      const t = tokens[j];
      if (t === undefined) continue;
      if (t.kind === 'whitespace' || t.kind === 'line-comment' || t.kind === 'block-comment') {
        continue;
      }
      if (lastTokIdx === null) {
        lastTokIdx = j;
        continue;
      }
      prevTokIdx = j;
      break;
    }
    if (lastTokIdx === null || prevTokIdx === null) return null;
    const aliasTok = tokens[lastTokIdx];
    const asTok = tokens[prevTokIdx];
    if (
      !(aliasTok?.kind === 'identifier' || aliasTok?.kind === 'backtick-identifier') ||
      asTok?.kind !== 'identifier' ||
      asTok.value.toUpperCase() !== 'AS'
    ) {
      return null;
    }
    const name =
      aliasTok.kind === 'backtick-identifier' ? aliasTok.value.slice(1, -1) : aliasTok.value;
    const expr = tr(argStart, prevTokIdx).trim();
    if (expr === '') return null;
    out.push({ name: name.replace(/"/g, '""'), expr });
    if (commaIdx === null) break;
    argStart = commaIdx + 1;
  }
  return out.length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// Argument-shape combinators (all take RewriteCtx; use ctx.tr to recurse)
// ---------------------------------------------------------------------------

/** Split a call's arguments on top-level commas, each translated. */
export function splitCallArgs(ctx: RewriteCtx, closeIdx: number): string[] {
  const { tokens, parenIdx, tr } = ctx;
  const args: string[] = [];
  let start = parenIdx + 1;
  while (start < closeIdx) {
    const commaIdx = findTopLevelComma(tokens, start, closeIdx);
    const end = commaIdx === null ? closeIdx : commaIdx;
    args.push(tr(start, end).trim());
    if (commaIdx === null) break;
    start = commaIdx + 1;
  }
  return args;
}

/** Emit `prefix(<recurse on args>)`, closing every `(` in `prefix` plus one. */
export function wrapCall(ctx: RewriteCtx, prefix: string): number {
  const { tokens, parenIdx, endIdx, out, tr } = ctx;
  const close = findMatchingClose(tokens, parenIdx, endIdx);
  const inner = tr(parenIdx + 1, close);
  const fullPrefix = `${prefix}(`;
  const opens = (fullPrefix.match(/\(/g) ?? []).length;
  out.push(`${fullPrefix}${inner}${')'.repeat(opens)}`);
  return close + 1;
}

/** Translate the entire arg list as one expression: `template(inner)`. Unlike
 * `rewriteOneArg` it does not reject commas (the inner string keeps them). */
export function rewriteWholeArg(
  ctx: RewriteCtx,
  template: (inner: string) => string,
  trim = false,
): number {
  const { tokens, parenIdx, endIdx, out, tr } = ctx;
  const close = findMatchingClose(tokens, parenIdx, endIdx);
  const inner = tr(parenIdx + 1, close);
  out.push(template(trim ? inner.trim() : inner));
  return close + 1;
}

/** 1-arg rewrite: `template(x)`. Errors if there's more than one arg. */
export function rewriteOneArg(ctx: RewriteCtx, template: (x: string) => string): number {
  const { tokens, parenIdx, endIdx, out, funcName, tr } = ctx;
  const close = findMatchingClose(tokens, parenIdx, endIdx);
  if (findTopLevelComma(tokens, parenIdx + 1, close) !== null) {
    throw BqError.invalid(`${funcName} requires exactly one argument.`, funcName);
  }
  out.push(template(tr(parenIdx + 1, close).trim()));
  return close + 1;
}

/** 2-arg rewrite: `template(a, b)`. */
export function rewriteTwoArg(ctx: RewriteCtx, template: (a: string, b: string) => string): number {
  const { tokens, parenIdx, endIdx, out, funcName, tr } = ctx;
  const close = findMatchingClose(tokens, parenIdx, endIdx);
  const commaIdx = findTopLevelComma(tokens, parenIdx + 1, close);
  if (commaIdx === null) {
    throw BqError.invalid(`${funcName} requires two arguments.`, funcName);
  }
  out.push(template(tr(parenIdx + 1, commaIdx).trim(), tr(commaIdx + 1, close).trim()));
  return close + 1;
}

/** GENERATE_DATE_ARRAY / GENERATE_TIMESTAMP_ARRAY → generate_series. */
export function rewriteGenerateArray(
  ctx: RewriteCtx,
  /** Trailing element cast (e.g. `::DATE`) or empty. */
  elementCast: string,
  /** Step appended when the call has only (start, end). */
  defaultStep = '',
): number {
  const { tokens, parenIdx, endIdx, out, funcName, tr } = ctx;
  const close = findMatchingClose(tokens, parenIdx, endIdx);
  const firstComma = findTopLevelComma(tokens, parenIdx + 1, close);
  const hasStep =
    firstComma !== null ? findTopLevelComma(tokens, firstComma + 1, close) !== null : false;
  let inner = tr(parenIdx + 1, close).trim();
  if (inner === '') {
    throw BqError.invalid(`${funcName} requires at least (start, end).`, funcName);
  }
  if (!hasStep && defaultStep !== '') {
    inner += `, ${defaultStep}`;
  }
  if (elementCast === '') {
    out.push(`generate_series(${inner})`);
  } else {
    out.push(`list_transform(generate_series(${inner}), x -> CAST(x AS ${elementCast.slice(2)}))`);
  }
  return close + 1;
}

/** TIMESTAMP_TRUNC / DATETIME_TRUNC: `duckFn('part', ts)<suffix>`. */
export function rewritePartArg2(ctx: RewriteCtx, duckFn: string, suffix: string): number {
  const { tokens, parenIdx, endIdx, out, funcName, tr } = ctx;
  const close = findMatchingClose(tokens, parenIdx, endIdx);
  const commaIdx = findTopLevelComma(tokens, parenIdx + 1, close);
  if (commaIdx === null) {
    throw BqError.invalid(`${funcName} requires (timestamp, PART).`, funcName);
  }
  const tsArg = tr(parenIdx + 1, commaIdx).trim();
  const part = sliceTokens(tokens, commaIdx + 1, close)
    .trim()
    .toLowerCase();
  out.push(`${duckFn}('${part}', ${tsArg})${suffix}`);
  return close + 1;
}

/** X_DIFF(a, b, PART) → date_diff('part', b, a) (swap for matching sign). */
export function rewriteDiff(ctx: RewriteCtx): number {
  const { tokens, parenIdx, endIdx, out, funcName, tr } = ctx;
  const close = findMatchingClose(tokens, parenIdx, endIdx);
  const commaIdx1 = findTopLevelComma(tokens, parenIdx + 1, close);
  if (commaIdx1 === null) {
    throw BqError.invalid(`${funcName} requires three arguments.`, funcName);
  }
  const commaIdx2 = findTopLevelComma(tokens, commaIdx1 + 1, close);
  if (commaIdx2 === null) {
    throw BqError.invalid(`${funcName} requires three arguments.`, funcName);
  }
  const a = tr(parenIdx + 1, commaIdx1).trim();
  const b = tr(commaIdx1 + 1, commaIdx2).trim();
  const part = sliceTokens(tokens, commaIdx2 + 1, close)
    .trim()
    .toLowerCase();
  out.push(`date_diff('${part}', ${b}, ${a})`);
  return close + 1;
}

/** REGEXP_REPLACE(s, pat, repl) → regexp_replace(..., 'g') (replace-all). */
export function rewriteRegexpReplace(ctx: RewriteCtx): number {
  const { tokens, parenIdx, endIdx, out, tr } = ctx;
  const close = findMatchingClose(tokens, parenIdx, endIdx);
  const inner = tr(parenIdx + 1, close).trim();
  out.push(`regexp_replace(${inner}, 'g')`);
  return close + 1;
}

/** TIMESTAMP_SUB/ADD(x, INTERVAL ...) → (x ± INTERVAL ...). */
export function rewriteTimestampArith(ctx: RewriteCtx, op: '-' | '+'): number {
  const { tokens, parenIdx, endIdx, out, funcName, tr } = ctx;
  const close = findMatchingClose(tokens, parenIdx, endIdx);
  const commaIdx = findTopLevelComma(tokens, parenIdx + 1, close);
  if (commaIdx === null) {
    throw BqError.invalid(`${funcName} requires two arguments.`, funcName);
  }
  const arg1 = tr(parenIdx + 1, commaIdx).trim();
  // Arg 2 is the INTERVAL clause; pass through verbatim.
  const arg2 = sliceTokens(tokens, commaIdx + 1, close).trim();
  out.push(`(${arg1} ${op} ${arg2})`);
  return close + 1;
}
