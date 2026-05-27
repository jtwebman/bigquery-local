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
} from './helpers.ts';

function currentTimestamp(c: RewriteCtx): number {
  const { tokens, i, parenIdx, endIdx, out, funcName } = c;
  const close = findMatchingClose(tokens, parenIdx, endIdx);
  if (areArgsEmpty(tokens, parenIdx, close)) {
    out.push('CURRENT_TIMESTAMP');
    return close + 1;
  }
  // CURRENT_TIMESTAMP(...) with args — let DuckDB handle / fail naturally.
  out.push(funcName);
  return i + 1;
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

export const datetimeHandlers: ReadonlyArray<[string, CallHandler]> = [
  ['CURRENT_TIMESTAMP', currentTimestamp],
  ['TIMESTAMP_SUB', (c) => rewriteTimestampArith(c, '-')],
  ['TIMESTAMP_ADD', (c) => rewriteTimestampArith(c, '+')],
  ['DATE_ADD', (c) => rewriteTwoArg(c, (d, iv) => `CAST((${d} + ${iv}) AS DATE)`)],
  ['DATE_SUB', (c) => rewriteTwoArg(c, (d, iv) => `CAST((${d} - ${iv}) AS DATE)`)],
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
  ['DATE_DIFF', rewriteDiff],
  ['TIMESTAMP_DIFF', rewriteDiff],
  ['DATETIME_DIFF', rewriteDiff],
];
