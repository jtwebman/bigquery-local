import type { CallHandler, RewriteCtx } from './context.ts';
import { findMatchingClose, rewriteTwoArg, rewriteWholeArg, splitCallArgs } from './helpers.ts';

// BQ GREATEST/LEAST return NULL if ANY arg is NULL; DuckDB ignores NULLs.
function greatestLeast(c: RewriteCtx, fn: 'GREATEST' | 'LEAST'): number {
  const close = findMatchingClose(c.tokens, c.parenIdx, c.endIdx);
  const args = splitCallArgs(c, close);
  const nullCheck = args.map((a) => `(${a}) IS NULL`).join(' OR ');
  c.out.push(`CASE WHEN ${nullCheck} THEN NULL ELSE ${fn}(${args.join(', ')}) END`);
  return close + 1;
}

export const mathHandlers: ReadonlyArray<[string, CallHandler]> = [
  // BQ integer division truncates toward zero — DuckDB's `//` matches.
  ['DIV', (c) => rewriteTwoArg(c, (a, b) => `(${a} // ${b})`)],
  ['GREATEST', (c) => greatestLeast(c, 'GREATEST')],
  ['LEAST', (c) => greatestLeast(c, 'LEAST')],
  ['SAFE_ADD', (c) => rewriteTwoArg(c, (a, b) => `TRY(${a} + ${b})`)],
  ['SAFE_SUBTRACT', (c) => rewriteTwoArg(c, (a, b) => `TRY(${a} - ${b})`)],
  ['SAFE_MULTIPLY', (c) => rewriteTwoArg(c, (a, b) => `TRY(${a} * ${b})`)],
  ['SAFE_NEGATE', (c) => rewriteWholeArg(c, (x) => `TRY(-(${x}))`, true)],
  // BQ returns NULL on divide-by-zero — NULLIF(y, 0) gives the same shape.
  ['SAFE_DIVIDE', (c) => rewriteTwoArg(c, (a, b) => `(${a} / NULLIF(${b}, 0))`)],
  // DuckDB DOUBLE / DOUBLE already follows IEEE 754 (±Inf, NaN).
  [
    'IEEE_DIVIDE',
    (c) => rewriteTwoArg(c, (a, b) => `(CAST(${a} AS DOUBLE) / CAST(${b} AS DOUBLE))`),
  ],
];
