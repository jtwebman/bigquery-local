import type { CallHandler } from './context.ts';
import { rewriteWholeArg } from './helpers.ts';

export const geoHandlers: ReadonlyArray<[string, CallHandler]> = [
  // DuckDB's ST_AsText inserts a space (`POINT (5 0)`); BQ omits it.
  ['ST_ASTEXT', (c) => rewriteWholeArg(c, (x) => `replace(ST_AsText(${x}), ' (', '(')`)],
];
