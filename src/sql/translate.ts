/**
 * BigQuery SQL → DuckDB SQL translator.
 *
 * Not a parser — a targeted token-stream rewriter. We pass through most
 * of the SQL unchanged and rewrite a fixed set of BQ-isms that DuckDB
 * doesn't accept verbatim:
 *
 *   `proj.dataset.table` (backtick)   →  "dataset"."table"
 *   `dataset.table`                   →  "dataset"."table"
 *   `name`                            →  "name"
 *   @paramName                        →  $N (positional; paramOrder lists names)
 *   CURRENT_TIMESTAMP()               →  CURRENT_TIMESTAMP
 *   TIMESTAMP_SUB(x, INTERVAL n U)    →  (x - INTERVAL n U)
 *   TIMESTAMP_ADD(x, INTERVAL n U)    →  (x + INTERVAL n U)
 *   JSON_VALUE(j, '$.path')           →  json_extract_string(j, '$.path')
 *   SAFE_CAST(x AS T)                 →  try_cast(x AS T)
 *   STARTS_WITH / ENDS_WITH           →  pass-through (DuckDB has them)
 *
 * Known-unsupported BigQuery functions throw `BqError.unsupportedFeature`
 * so the caller surfaces a precise error to the API client. Anything else
 * is passed through verbatim — if it's a DuckDB-compatible identifier or
 * function, it just works; if it isn't, DuckDB itself returns the error
 * and the route layer turns that into a 400.
 */

import { BqError } from '../util/errors.ts';
import { type Token, tokenize } from './tokenize.ts';

export interface TranslateResult {
  /** DuckDB-ready SQL. */
  readonly sql: string;
  /** Parameter names in `$1`, `$2`, … order. The caller maps named values
   * into a positional array using this list. */
  readonly paramOrder: readonly string[];
}

/** A small list of BQ functions we explicitly call out as unsupported, so
 * the error is "BigQuery feature not supported in v0" rather than a vague
 * DuckDB "function does not exist". Grow this as we hit real cases. */
const UNSUPPORTED_FUNCTIONS = new Set([
  'FARM_FINGERPRINT',
  'APPROX_COUNT_DISTINCT',
  'APPROX_QUANTILES',
  'GENERATE_UUID',
  'NET.IP_FROM_STRING',
  'ST_GEOGFROMTEXT',
  'ST_INTERSECTS',
  'ST_DISTANCE',
  'ML.PREDICT',
  'ML.EVALUATE',
  'SEARCH',
  'VECTOR_SEARCH',
]);

export function translate(sql: string): TranslateResult {
  const tokens = tokenize(sql);
  const paramOrder: string[] = [];
  const out = translateRange(tokens, 0, tokens.length, paramOrder);
  return { sql: out, paramOrder };
}

// ---------------------------------------------------------------------------
// Core walk
// ---------------------------------------------------------------------------

function translateRange(
  tokens: readonly Token[],
  startIdx: number,
  endIdx: number,
  paramOrder: string[],
): string {
  const out: string[] = [];
  let i = startIdx;
  while (i < endIdx) {
    const tok = tokens[i];
    if (tok === undefined) break;

    switch (tok.kind) {
      case 'backtick-identifier':
        out.push(rewriteBacktick(tok));
        i += 1;
        break;
      case 'parameter':
        out.push(rewriteParameter(tok, paramOrder));
        i += 1;
        break;
      case 'identifier':
        i = handleIdentifier(tokens, i, endIdx, out, paramOrder);
        break;
      default:
        out.push(tok.value);
        i += 1;
        break;
    }
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// Backticks → DuckDB quoted identifiers
// ---------------------------------------------------------------------------

function rewriteBacktick(tok: Token): string {
  // `proj.dataset.table` → "dataset"."table"
  // `dataset.table`      → "dataset"."table"
  // `name`               → "name"
  const inner = tok.value.slice(1, -1); // strip backticks
  const parts = inner.split('.').filter((p) => p !== '');
  // If we have a three-part name, drop the project — v0 is single-project.
  const useParts = parts.length === 3 ? parts.slice(1) : parts;
  return useParts.map((p) => `"${p.replace(/"/g, '""')}"`).join('.');
}

// ---------------------------------------------------------------------------
// Named params → positional placeholders
// ---------------------------------------------------------------------------

function rewriteParameter(tok: Token, paramOrder: string[]): string {
  const name = tok.value.slice(1); // strip leading '@'
  let idx = paramOrder.indexOf(name);
  if (idx === -1) {
    paramOrder.push(name);
    idx = paramOrder.length - 1;
  }
  return `$${idx + 1}`;
}

// ---------------------------------------------------------------------------
// Identifier-as-function-call dispatch
// ---------------------------------------------------------------------------

function handleIdentifier(
  tokens: readonly Token[],
  i: number,
  endIdx: number,
  out: string[],
  paramOrder: string[],
): number {
  const tok = tokens[i];
  if (tok === undefined) return i + 1;
  const upper = tok.value.toUpperCase();

  // `IN UNNEST(<expr>)` → `= ANY (<expr>)`. DuckDB doesn't accept the BQ
  // `IN UNNEST(array)` membership idiom but does accept `= ANY(array)`.
  if (upper === 'IN') {
    const unnestIdx = skipWhitespace(tokens, i + 1, endIdx);
    if (unnestIdx !== null) {
      const next = tokens[unnestIdx];
      if (next?.kind === 'identifier' && next.value.toUpperCase() === 'UNNEST') {
        const openParen = findFollowingOpenParen(tokens, unnestIdx + 1, endIdx);
        if (openParen !== null) {
          // Emit `= ANY (`; the main loop will translate the contents
          // (including any param rewrites) and the closing `)` flows
          // through as a regular punctuation token.
          out.push('= ANY (');
          return openParen + 1;
        }
      }
    }
    out.push(tok.value);
    return i + 1;
  }

  // If this identifier is immediately followed by `(`, it's a function call.
  // Otherwise it's just a name (column, table, alias) — pass it through.
  const parenIdx = findFollowingOpenParen(tokens, i + 1, endIdx);
  if (parenIdx === null) {
    if (UNSUPPORTED_FUNCTIONS.has(upper)) {
      throw BqError.unsupportedFeature(
        `BigQuery feature not supported in v0: ${tok.value}`,
        tok.value,
      );
    }
    out.push(tok.value);
    return i + 1;
  }

  switch (upper) {
    case 'CURRENT_TIMESTAMP': {
      const close = findMatchingClose(tokens, parenIdx, endIdx);
      if (areArgsEmpty(tokens, parenIdx, close)) {
        out.push('CURRENT_TIMESTAMP');
        return close + 1;
      }
      // CURRENT_TIMESTAMP(...) with args — let DuckDB handle / fail naturally.
      out.push(tok.value);
      return i + 1;
    }

    case 'TIMESTAMP_SUB':
      return rewriteTimestampArith(tokens, i, parenIdx, endIdx, '-', out, paramOrder);

    case 'TIMESTAMP_ADD':
      return rewriteTimestampArith(tokens, i, parenIdx, endIdx, '+', out, paramOrder);

    case 'JSON_VALUE':
      out.push('json_extract_string');
      return i + 1;

    case 'SAFE_CAST':
      out.push('try_cast');
      return i + 1;

    default:
      if (UNSUPPORTED_FUNCTIONS.has(upper)) {
        throw BqError.unsupportedFeature(
          `BigQuery feature not supported in v0: ${tok.value}`,
          tok.value,
        );
      }
      // Pass-through (covers STARTS_WITH / ENDS_WITH and every other
      // function whose name DuckDB happens to accept).
      out.push(tok.value);
      return i + 1;
  }
}

// ---------------------------------------------------------------------------
// TIMESTAMP_SUB / TIMESTAMP_ADD rewrite
// ---------------------------------------------------------------------------

function rewriteTimestampArith(
  tokens: readonly Token[],
  funcIdx: number,
  openParenIdx: number,
  endIdx: number,
  op: '-' | '+',
  out: string[],
  paramOrder: string[],
): number {
  const close = findMatchingClose(tokens, openParenIdx, endIdx);
  const commaIdx = findTopLevelComma(tokens, openParenIdx + 1, close);
  const funcTok = tokens[funcIdx];
  if (commaIdx === null) {
    throw BqError.invalid(
      `${funcTok?.value ?? 'TIMESTAMP_SUB'} requires two arguments.`,
      funcTok?.value ?? 'TIMESTAMP_SUB',
    );
  }
  // Arg 1 is an arbitrary expression — recurse to apply any nested rewrites.
  const arg1 = translateRange(tokens, openParenIdx + 1, commaIdx, paramOrder).trim();
  // Arg 2 is the INTERVAL clause; pass through verbatim (trimmed).
  const arg2 = sliceTokens(tokens, commaIdx + 1, close).trim();
  out.push(`(${arg1} ${op} ${arg2})`);
  return close + 1;
}

// ---------------------------------------------------------------------------
// Token-stream helpers
// ---------------------------------------------------------------------------

/** Returns the index of the first non-whitespace token in [start, end), or
 * null if none exists. */
function skipWhitespace(tokens: readonly Token[], start: number, end: number): number | null {
  for (let j = start; j < end; j += 1) {
    const t = tokens[j];
    if (t === undefined) return null;
    if (t.kind !== 'whitespace' && t.kind !== 'line-comment' && t.kind !== 'block-comment') {
      return j;
    }
  }
  return null;
}

function findFollowingOpenParen(
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

function findMatchingClose(tokens: readonly Token[], openIdx: number, end: number): number {
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

function findTopLevelComma(
  tokens: readonly Token[],
  start: number,
  closeIdx: number,
): number | null {
  let depth = 0;
  for (let j = start; j < closeIdx; j += 1) {
    const t = tokens[j];
    if (t === undefined) continue;
    if (t.kind === 'punctuation' && t.value === '(') depth += 1;
    else if (t.kind === 'punctuation' && t.value === ')') depth -= 1;
    else if (t.kind === 'punctuation' && t.value === ',' && depth === 0) {
      return j;
    }
  }
  return null;
}

function areArgsEmpty(tokens: readonly Token[], openIdx: number, closeIdx: number): boolean {
  for (let j = openIdx + 1; j < closeIdx; j += 1) {
    const t = tokens[j];
    if (t === undefined) continue;
    if (t.kind !== 'whitespace' && t.kind !== 'line-comment' && t.kind !== 'block-comment') {
      return false;
    }
  }
  return true;
}

function sliceTokens(tokens: readonly Token[], startIdx: number, endIdx: number): string {
  let out = '';
  for (let j = startIdx; j < endIdx; j += 1) {
    const t = tokens[j];
    if (t === undefined) continue;
    out += t.value;
  }
  return out;
}
