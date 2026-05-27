import type { CallHandler, RewriteCtx } from './context.ts';
import {
  extractStringLiteral,
  findMatchingClose,
  findTopLevelComma,
  hasCaptureGroup,
  rewriteRegexpReplace,
  rewriteWholeArg,
  skipWhitespace,
  splitCallArgs,
  wrapCall,
} from './helpers.ts';

// BQ: returns first capture group if the pattern has one, else the whole
// match. DuckDB returns the whole match unless an explicit group index is
// given — append `, 1` when the pattern literal has a capture group.
function regexpExtract(c: RewriteCtx): number {
  const { tokens, parenIdx, endIdx, out, tr } = c;
  const close = findMatchingClose(tokens, parenIdx, endIdx);
  const commaIdx = findTopLevelComma(tokens, parenIdx + 1, close);
  if (commaIdx !== null) {
    const trailingCommaIdx = findTopLevelComma(tokens, commaIdx + 1, close);
    if (trailingCommaIdx === null) {
      const patternIdx = skipWhitespace(tokens, commaIdx + 1, close);
      const patternTok = patternIdx !== null ? tokens[patternIdx] : undefined;
      const patternValue = extractStringLiteral(patternTok);
      if (patternValue !== null && hasCaptureGroup(patternValue)) {
        out.push(`regexp_extract(${tr(parenIdx + 1, close)}, 1)`);
        return close + 1;
      }
    }
  }
  out.push(`regexp_extract(${tr(parenIdx + 1, close)})`);
  return close + 1;
}

// BQ CONCAT propagates NULL; DuckDB concat() skips NULLs. `||` propagates
// correctly but constant-folds all-NULL to an untyped NULL — cast to VARCHAR
// to keep the STRING result type.
function concat(c: RewriteCtx): number {
  const close = findMatchingClose(c.tokens, c.parenIdx, c.endIdx);
  const args = splitCallArgs(c, close);
  c.out.push(`CAST((${args.join(' || ')}) AS VARCHAR)`);
  return close + 1;
}

export const stringHandlers: ReadonlyArray<[string, CallHandler]> = [
  // BQ NORMALIZE_AND_CASEFOLD = lower(nfc_normalize(...)).
  ['NORMALIZE_AND_CASEFOLD', (c) => wrapCall(c, 'lower(nfc_normalize')],
  ['REGEXP_REPLACE', rewriteRegexpReplace],
  ['REGEXP_EXTRACT', regexpExtract],
  // BQ TO_HEX is lowercase; DuckDB to_hex is uppercase.
  ['TO_HEX', (c) => rewriteWholeArg(c, (x) => `lower(to_hex(${x}))`)],
  // BQ hash fns return BYTES (raw digest); DuckDB returns a hex string — wrap
  // in unhex() so the result is BYTES and TO_HEX behaves as in BQ.
  ['MD5', (c) => rewriteWholeArg(c, (x) => `unhex(md5(${x}))`)],
  ['SHA1', (c) => rewriteWholeArg(c, (x) => `unhex(sha1(${x}))`)],
  ['SHA256', (c) => rewriteWholeArg(c, (x) => `unhex(sha256(${x}))`)],
  // DuckDB has no sha512; the bq_sha512 UDF (Node crypto) returns BYTES.
  ['SHA512', (c) => rewriteWholeArg(c, (x) => `bq_sha512(${x})`)],
  ['CONCAT', concat],
];
