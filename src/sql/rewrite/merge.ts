/**
 * MERGE source-column qualification.
 *
 * BigQuery's `MERGE … WHEN NOT MATCHED THEN INSERT (cols) VALUES (vals)`
 * resolves unqualified column references in the VALUES list to the source
 * (the `USING` relation). DuckDB's MERGE treats the same unqualified names as
 * ambiguous when source and target share column names (`id`, etc.) and errors.
 *
 * dbt's incremental materialization emits exactly this shape on every
 * subsequent run, so we rewrite the unqualified VALUES references to be
 * source-qualified (`SOURCE_ALIAS.col`) before the statement reaches DuckDB.
 * Only the INSERT VALUES list is touched; UPDATE SET and the ON condition are
 * left as written (dbt already qualifies those).
 */

import { type Token, isSkippable, nextNonSkippable, tokenize } from '../tokenize.ts';
import { findMatchingClose } from './helpers.ts';

// Bare identifiers in a VALUES list that are literals/keywords, not columns.
const VALUE_KEYWORDS = new Set(['NULL', 'TRUE', 'FALSE', 'DEFAULT']);

function firstKeyword(tokens: readonly Token[]): string | null {
  let i = 0;
  while (i < tokens.length && isSkippable(tokens[i] as Token)) i += 1;
  const tok = tokens[i];
  return tok?.kind === 'identifier' ? tok.value.toUpperCase() : null;
}

/** Index of the first identifier `kw` at paren-depth 0 at or after `start`. */
function findKeywordDepth0(tokens: readonly Token[], start: number, kw: string): number | null {
  let depth = 0;
  for (let i = start; i < tokens.length; i += 1) {
    const tok = tokens[i] as Token;
    if (tok.kind === 'punctuation') {
      if (tok.value === '(') depth += 1;
      else if (tok.value === ')') depth -= 1;
    }
    if (depth === 0 && tok.kind === 'identifier' && tok.value.toUpperCase() === kw) return i;
  }
  return null;
}

function prevNonSkippable(
  tokens: readonly Token[],
  start: number,
  lowerBound: number,
): number | null {
  for (let i = start; i > lowerBound; i -= 1) {
    if (!isSkippable(tokens[i] as Token)) return i;
  }
  return null;
}

export function qualifyMergeInsertValues(sql: string): string {
  const tokens = tokenize(sql);
  if (firstKeyword(tokens) !== 'MERGE') return sql;

  const usingIdx = findKeywordDepth0(tokens, 0, 'USING');
  if (usingIdx === null) return sql;
  const onIdx = findKeywordDepth0(tokens, usingIdx + 1, 'ON');
  if (onIdx === null) return sql;

  // Source alias = the identifier just before ON (after the source relation and
  // an optional AS). If there's no alias, we can't safely qualify — bail.
  const aliasIdx = prevNonSkippable(tokens, onIdx - 1, usingIdx);
  const aliasTok = aliasIdx === null ? undefined : tokens[aliasIdx];
  if (aliasTok?.kind !== 'identifier' || aliasTok.value.toUpperCase() === 'AS') return sql;
  const alias = aliasTok.value;

  const insertOffsets: number[] = [];
  for (let k = onIdx + 1; k < tokens.length; k += 1) {
    const tok = tokens[k] as Token;
    if (tok.kind !== 'identifier' || tok.value.toUpperCase() !== 'VALUES') continue;
    const open = nextNonSkippable(tokens, k + 1);
    if (tokens[open]?.kind !== 'punctuation' || tokens[open]?.value !== '(') continue;
    const close = findMatchingClose(tokens, open, tokens.length);
    for (let m = open + 1; m < close; m += 1) {
      const col = tokens[m] as Token;
      if (col.kind !== 'identifier' && col.kind !== 'backtick-identifier') continue;
      if (col.kind === 'identifier' && VALUE_KEYWORDS.has(col.value.toUpperCase())) continue;
      const prev = prevNonSkippable(tokens, m - 1, open);
      // Already qualified (this is the column part after a `.`).
      if (prev !== null && tokens[prev]?.kind === 'punctuation' && tokens[prev]?.value === '.') {
        continue;
      }
      const next = nextNonSkippable(tokens, m + 1);
      if (next < close && tokens[next]?.kind === 'punctuation') {
        // `x.` → this is a qualifier; `f(` → a function call. Skip both.
        if (tokens[next]?.value === '.' || tokens[next]?.value === '(') continue;
      }
      insertOffsets.push(col.start);
    }
    k = close;
  }

  if (insertOffsets.length === 0) return sql;
  insertOffsets.sort((a, b) => b - a);
  let out = sql;
  for (const pos of insertOffsets) {
    out = `${out.slice(0, pos)}${alias}.${out.slice(pos)}`;
  }
  return out;
}
