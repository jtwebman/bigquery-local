import { BqError } from '../../util/errors.ts';
import { sliceTokens } from '../tokenize.ts';
import type { CallHandler, RewriteCtx } from './context.ts';
import {
  areArgsEmpty,
  findMatchingClose,
  findTopLevelComma,
  rewriteDiff,
  rewriteGenerateArray,
  rewriteOneArg,
  rewritePartArg2,
  rewriteTimestampArith,
  rewriteTwoArg,
  skipWhitespace,
  splitCallArgs,
} from './helpers.ts';

// Emit `replacement` when called with no args, else pass through.
function nullary(replacement: string): CallHandler {
  return (c: RewriteCtx): number => {
    const { tokens, i, parenIdx, endIdx, out, funcName } = c;
    const close = findMatchingClose(tokens, parenIdx, endIdx);
    if (areArgsEmpty(tokens, parenIdx, close)) {
      out.push(replacement);
      return close + 1;
    }
    out.push(funcName);
    return i + 1;
  };
}

// EXTRACT(<part> FROM <expr>): DAYOFWEEK is BQ Sun=1..Sat=7 vs DuckDB
// Sun=0..Sat=6 (+1); ISOWEEK isn't a DuckDB specifier (its `week` is ISO).
function extract(c: RewriteCtx): number {
  const { tokens, parenIdx, endIdx, out, tr } = c;
  const close = findMatchingClose(tokens, parenIdx, endIdx);
  const firstArgIdx = skipWhitespace(tokens, parenIdx + 1, close);
  const firstArg = firstArgIdx !== null ? tokens[firstArgIdx] : undefined;
  const partName = firstArg?.kind === 'identifier' ? firstArg.value.toUpperCase() : '';
  if (partName === 'ISOWEEK' && firstArgIdx !== null) {
    out.push(`EXTRACT(week${tr(firstArgIdx + 1, close)})`);
    return close + 1;
  }
  const inner = tr(parenIdx + 1, close);
  out.push(partName === 'DAYOFWEEK' ? `(EXTRACT(${inner})::BIGINT + 1)` : `EXTRACT(${inner})`);
  return close + 1;
}

// DuckDB date_trunc returns TIMESTAMP (cast to DATE); BQ weeks start Sunday,
// DuckDB 'week' starts Monday — shift a day each side so it lands on Sunday.
function dateTrunc(c: RewriteCtx): number {
  const { tokens, parenIdx, endIdx, out, funcName, tr } = c;
  const close = findMatchingClose(tokens, parenIdx, endIdx);
  const commaIdx = findTopLevelComma(tokens, parenIdx + 1, close);
  if (commaIdx === null) {
    throw BqError.invalid('DATE_TRUNC requires (date, PART).', funcName);
  }
  const dateArg = tr(parenIdx + 1, commaIdx).trim();
  const part = sliceTokens(tokens, commaIdx + 1, close)
    .trim()
    .toLowerCase();
  if (part === 'week') {
    out.push(`CAST((date_trunc('week', ${dateArg} + INTERVAL 1 DAY) - INTERVAL 1 DAY) AS DATE)`);
  } else {
    out.push(`date_trunc('${part}', ${dateArg})::DATE`);
  }
  return close + 1;
}

// `byArity` returns DuckDB SQL for a given translated arg list, or null to
// pass through. (The `NAME '...'` typed-literal form isn't a call, so it
// never reaches here.)
function arityCtor(byArity: (args: string[]) => string | null): CallHandler {
  return (c: RewriteCtx): number => {
    const { tokens, i, parenIdx, endIdx, out, funcName } = c;
    const close = findMatchingClose(tokens, parenIdx, endIdx);
    const sql = byArity(splitCallArgs(c, close));
    if (sql === null) {
      out.push(funcName);
      return i + 1;
    }
    out.push(sql);
    return close + 1;
  };
}

export const datetimeHandlers: ReadonlyArray<[string, CallHandler]> = [
  ['CURRENT_TIMESTAMP', nullary('CURRENT_TIMESTAMP')],
  ['CURRENT_DATETIME', nullary('current_localtimestamp()')],
  ['CURRENT_TIME', nullary('CAST(get_current_time() AS TIME)')],
  ['TIMESTAMP_SUB', (c) => rewriteTimestampArith(c, '-')],
  ['TIMESTAMP_ADD', (c) => rewriteTimestampArith(c, '+')],
  ['DATE_ADD', (c) => rewriteTwoArg(c, (d, iv) => `CAST((${d} + ${iv}) AS DATE)`)],
  ['DATE_SUB', (c) => rewriteTwoArg(c, (d, iv) => `CAST((${d} - ${iv}) AS DATE)`)],
  ['DATETIME_ADD', (c) => rewriteTwoArg(c, (d, iv) => `(${d} + ${iv})`)],
  ['DATETIME_SUB', (c) => rewriteTwoArg(c, (d, iv) => `(${d} - ${iv})`)],
  ['EXTRACT', extract],
  ['TIMESTAMP_TRUNC', (c) => rewritePartArg2(c, 'date_trunc', '')],
  ['DATETIME_TRUNC', (c) => rewritePartArg2(c, 'date_trunc', '')],
  ['DATE_TRUNC', dateTrunc],
  ['FORMAT_TIMESTAMP', (c) => rewriteTwoArg(c, (fmt, x) => `strftime(${x}, ${fmt})`)],
  ['FORMAT_DATE', (c) => rewriteTwoArg(c, (fmt, x) => `strftime(${x}, ${fmt})`)],
  ['FORMAT_DATETIME', (c) => rewriteTwoArg(c, (fmt, x) => `strftime(${x}, ${fmt})`)],
  ['PARSE_TIMESTAMP', (c) => rewriteTwoArg(c, (fmt, s) => `strptime(${s}, ${fmt})`)],
  ['PARSE_DATETIME', (c) => rewriteTwoArg(c, (fmt, s) => `strptime(${s}, ${fmt})`)],
  ['PARSE_DATE', (c) => rewriteTwoArg(c, (fmt, s) => `CAST(strptime(${s}, ${fmt}) AS DATE)`)],
  ['GENERATE_DATE_ARRAY', (c) => rewriteGenerateArray(c, '::DATE', 'INTERVAL 1 DAY')],
  ['GENERATE_TIMESTAMP_ARRAY', (c) => rewriteGenerateArray(c, '')],
  [
    'DATE_FROM_UNIX_DATE',
    (c) => rewriteOneArg(c, (x) => `CAST(DATE '1970-01-01' + INTERVAL (${x}) DAY AS DATE)`),
  ],
  ['UNIX_DATE', (c) => rewriteOneArg(c, (x) => `date_diff('day', DATE '1970-01-01', ${x})`)],
  ['UNIX_SECONDS', (c) => rewriteOneArg(c, (x) => `CAST(epoch(${x}) AS BIGINT)`)],
  // make_timestamp takes microseconds; ::TIMESTAMPTZ so it wires as BQ TIMESTAMP.
  [
    'TIMESTAMP_SECONDS',
    (c) => rewriteOneArg(c, (x) => `make_timestamp((${x}) * 1000000)::TIMESTAMPTZ`),
  ],
  [
    'TIMESTAMP_MILLIS',
    (c) => rewriteOneArg(c, (x) => `make_timestamp((${x}) * 1000)::TIMESTAMPTZ`),
  ],
  ['TIMESTAMP_MICROS', (c) => rewriteOneArg(c, (x) => `make_timestamp(${x})::TIMESTAMPTZ`)],
  ['DATE_DIFF', rewriteDiff],
  ['TIMESTAMP_DIFF', rewriteDiff],
  ['DATETIME_DIFF', rewriteDiff],
  [
    'DATE',
    arityCtor((a) =>
      a.length === 3
        ? `make_date(${a.join(', ')})`
        : a.length === 1
          ? `CAST(${a[0]} AS DATE)`
          : null,
    ),
  ],
  [
    'TIME',
    arityCtor((a) =>
      a.length === 3
        ? `make_time(${a.join(', ')})`
        : a.length === 1
          ? `CAST(${a[0]} AS TIME)`
          : null,
    ),
  ],
  [
    'DATETIME',
    arityCtor((a) =>
      a.length === 6
        ? `make_timestamp(${a.join(', ')})`
        : a.length === 1
          ? `CAST(${a[0]} AS TIMESTAMP)`
          : null,
    ),
  ],
  ['TIMESTAMP', arityCtor((a) => (a.length === 1 ? `CAST(${a[0]} AS TIMESTAMPTZ)` : null))],
];
