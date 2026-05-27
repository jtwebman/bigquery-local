import type { CallHandler } from './context.ts';
import { rewriteOneArg, rewriteWholeArg } from './helpers.ts';

export const jsonHandlers: ReadonlyArray<[string, CallHandler]> = [
  // DuckDB's json_type returns uppercase (OBJECT); BQ lowercase (object).
  ['JSON_TYPE', (c) => rewriteWholeArg(c, (x) => `lower(json_type(${x}))`)],
  ['PARSE_JSON', (c) => rewriteOneArg(c, (x) => `CAST(${x} AS JSON)`)],
  // BQ BOOL/INT64/FLOAT64(json) extract a scalar — CAST handles primitives.
  ['BOOL', (c) => rewriteOneArg(c, (x) => `CAST(${x} AS BOOLEAN)`)],
  ['INT64', (c) => rewriteOneArg(c, (x) => `CAST(${x} AS BIGINT)`)],
  ['FLOAT64', (c) => rewriteOneArg(c, (x) => `CAST(${x} AS DOUBLE)`)],
];
