import type { CallHandler, RewriteCtx } from './context.ts';
import {
  findMatchingClose,
  parseWithOffset,
  rewriteOneArg,
  skipWhitespace,
  tryParseStructNamedArgs,
} from './helpers.ts';

// BQ STRUCT(expr AS name, ...) → DuckDB {name: expr, ...} when every arg is
// named; positional STRUCT(...) drops to a row expression.
function struct(c: RewriteCtx): number {
  const { tokens, parenIdx, endIdx, out, tr } = c;
  const close = findMatchingClose(tokens, parenIdx, endIdx);
  const namedFields = tryParseStructNamedArgs(c, parenIdx + 1, close);
  if (namedFields !== null) {
    const body = namedFields.map(({ name, expr }) => `"${name}": ${expr}`).join(', ');
    out.push(`{${body}}`);
    return close + 1;
  }
  out.push(`(${tr(parenIdx + 1, close)})`);
  return close + 1;
}

// BQ UNNEST(expr) AS x names the column x; DuckDB parses AS x as a table alias
// (column stays `unnest`). Rewrite to `AS _unnest_alias(x)`; WITH OFFSET emits
// a parallel range unnest. Skip if already in DuckDB's `AS t(c)` form.
function unnest(c: RewriteCtx): number {
  const { tokens, i, parenIdx, endIdx, out, funcName, tr } = c;
  const close = findMatchingClose(tokens, parenIdx, endIdx);
  const afterParen = skipWhitespace(tokens, close + 1, endIdx);
  if (afterParen !== null) {
    const asTok = tokens[afterParen];
    if (asTok?.kind === 'identifier' && asTok.value.toUpperCase() === 'AS') {
      const nameIdx = skipWhitespace(tokens, afterParen + 1, endIdx);
      const nameTok = nameIdx !== null ? tokens[nameIdx] : undefined;
      if (
        (nameTok?.kind === 'identifier' || nameTok?.kind === 'backtick-identifier') &&
        nameIdx !== null
      ) {
        const followIdx = skipWhitespace(tokens, nameIdx + 1, endIdx);
        const follow = followIdx !== null ? tokens[followIdx] : undefined;
        const alreadyHasColAlias = follow?.kind === 'punctuation' && follow.value === '(';
        const colName =
          nameTok.kind === 'backtick-identifier' ? nameTok.value.slice(1, -1) : nameTok.value;
        const q = (s: string): string => `"${s.replace(/"/g, '""')}"`;
        const offset = followIdx !== null ? parseWithOffset(tokens, followIdx, endIdx) : null;
        if (offset !== null && !alreadyHasColAlias) {
          const inner = tr(parenIdx + 1, close);
          out.push(
            `(SELECT UNNEST(${inner}) AS ${q(colName)}, ` +
              `UNNEST(range(0, len(${inner}))) AS ${q(offset.name)}) AS _unnest_offset`,
          );
          return offset.nextIdx;
        }
        if (!alreadyHasColAlias) {
          const inner = tr(parenIdx + 1, close);
          out.push(`UNNEST(${inner}) AS _unnest_alias(${q(colName)})`);
          return nameIdx + 1;
        }
      }
    }
  }
  out.push(funcName);
  return i + 1;
}

export const arrayHandlers: ReadonlyArray<[string, CallHandler]> = [
  ['STRUCT', struct],
  ['UNNEST', unnest],
  // BQ arr[OFFSET(n)] is 0-indexed; DuckDB subscripts are 1-indexed (and NULL
  // on out-of-range, matching SAFE_OFFSET) — both reduce to n + 1.
  ['OFFSET', (c) => rewriteOneArg(c, (n) => `(${n} + 1)`)],
  ['SAFE_OFFSET', (c) => rewriteOneArg(c, (n) => `(${n} + 1)`)],
  // BQ arr[ORDINAL(n)] is 1-indexed — matches DuckDB directly.
  ['ORDINAL', (c) => rewriteOneArg(c, (n) => `(${n})`)],
  // DuckDB lists are 1-indexed; -1 is the last element.
  ['ARRAY_FIRST', (c) => rewriteOneArg(c, (x) => `list_extract(${x}, 1)`)],
  ['ARRAY_LAST', (c) => rewriteOneArg(c, (x) => `list_extract(${x}, -1)`)],
  [
    'ARRAY_CONCAT_AGG',
    (c) => rewriteOneArg(c, (x) => `flatten(array_agg(${x}) FILTER (WHERE ${x} IS NOT NULL))`),
  ],
  ['COUNTIF', (c) => rewriteOneArg(c, (cond) => `COUNT(*) FILTER (WHERE ${cond})`)],
];
