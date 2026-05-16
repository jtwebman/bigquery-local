import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { translate } from '../../../src/sql/translate.ts';
import { BqError } from '../../../src/util/errors.ts';

function norm(sql: string): string {
  // Collapse whitespace for easier comparison.
  return sql.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Backticks
// ---------------------------------------------------------------------------

test('translate: `dataset.table` becomes "dataset"."table"', () => {
  const { sql } = translate('SELECT * FROM `ds1.events`');
  assert.equal(norm(sql), 'SELECT * FROM "ds1"."events"');
});

test('translate: 3-part `proj.ds.tbl` drops the project segment', () => {
  const { sql } = translate('SELECT * FROM `my-project.ds.events`');
  assert.equal(norm(sql), 'SELECT * FROM "ds"."events"');
});

test('translate: single-segment `name` becomes "name"', () => {
  const { sql } = translate('SELECT * FROM `events`');
  assert.equal(norm(sql), 'SELECT * FROM "events"');
});

test('translate: backtick identifiers inside strings are NOT touched', () => {
  const { sql } = translate("SELECT '`literal`' FROM t");
  assert.equal(norm(sql), "SELECT '`literal`' FROM t");
});

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

test('translate: @name becomes $1 and paramOrder records the name', () => {
  const { sql, paramOrder } = translate('SELECT * FROM t WHERE id = @id');
  assert.equal(norm(sql), 'SELECT * FROM t WHERE id = $1');
  assert.deepEqual(paramOrder, ['id']);
});

test('translate: multiple distinct @-params get sequential $1, $2', () => {
  const { sql, paramOrder } = translate('SELECT * FROM t WHERE id = @id AND name = @name');
  assert.equal(norm(sql), 'SELECT * FROM t WHERE id = $1 AND name = $2');
  assert.deepEqual(paramOrder, ['id', 'name']);
});

test('translate: repeated @name reuses the same $N', () => {
  const { sql, paramOrder } = translate('SELECT * FROM t WHERE a = @x OR b = @x');
  assert.equal(norm(sql), 'SELECT * FROM t WHERE a = $1 OR b = $1');
  assert.deepEqual(paramOrder, ['x']);
});

test('translate: @ inside a string is NOT a parameter', () => {
  const { sql, paramOrder } = translate("SELECT 'email@host' AS x");
  assert.equal(norm(sql), "SELECT 'email@host' AS x");
  assert.deepEqual(paramOrder, []);
});

// ---------------------------------------------------------------------------
// CURRENT_TIMESTAMP()
// ---------------------------------------------------------------------------

test('translate: CURRENT_TIMESTAMP() loses its parens', () => {
  const { sql } = translate('SELECT CURRENT_TIMESTAMP()');
  assert.equal(norm(sql), 'SELECT CURRENT_TIMESTAMP');
});

test('translate: CURRENT_TIMESTAMP (no parens) passes through unchanged', () => {
  const { sql } = translate('SELECT CURRENT_TIMESTAMP');
  assert.equal(norm(sql), 'SELECT CURRENT_TIMESTAMP');
});

// ---------------------------------------------------------------------------
// TIMESTAMP_SUB / TIMESTAMP_ADD
// ---------------------------------------------------------------------------

test('translate: TIMESTAMP_SUB(x, INTERVAL n DAY) becomes (x - INTERVAL n DAY)', () => {
  const { sql } = translate('TIMESTAMP_SUB(col, INTERVAL 7 DAY)');
  assert.equal(norm(sql), '(col - INTERVAL 7 DAY)');
});

test('translate: TIMESTAMP_ADD(x, INTERVAL n HOUR) becomes (x + INTERVAL n HOUR)', () => {
  const { sql } = translate('TIMESTAMP_ADD(col, INTERVAL 1 HOUR)');
  assert.equal(norm(sql), '(col + INTERVAL 1 HOUR)');
});

test('translate: TIMESTAMP_SUB rewrites inside larger expression', () => {
  const { sql, paramOrder } = translate(
    'WHERE created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)',
  );
  assert.equal(norm(sql), 'WHERE created_at >= (CURRENT_TIMESTAMP - INTERVAL 7 DAY)');
  assert.deepEqual(paramOrder, []);
});

test('translate: TIMESTAMP_SUB with a parameterized first arg', () => {
  const { sql, paramOrder } = translate('TIMESTAMP_SUB(@since, INTERVAL 1 DAY)');
  assert.equal(norm(sql), '($1 - INTERVAL 1 DAY)');
  assert.deepEqual(paramOrder, ['since']);
});

test('translate: TIMESTAMP_SUB with missing second arg throws invalid', () => {
  assert.throws(
    () => translate('TIMESTAMP_SUB(col)'),
    (err: unknown) => err instanceof BqError && err.reason === 'invalid',
  );
});

// ---------------------------------------------------------------------------
// JSON_VALUE / SAFE_CAST / STARTS_WITH / ENDS_WITH
// ---------------------------------------------------------------------------

test('translate: JSON_VALUE renamed to json_extract_string', () => {
  const { sql } = translate("JSON_VALUE(payload, '$.path')");
  assert.equal(norm(sql), "json_extract_string(payload, '$.path')");
});

test('translate: SAFE_CAST renamed to try_cast', () => {
  const { sql } = translate('SAFE_CAST(col AS INT64)');
  assert.equal(norm(sql), 'try_cast(col AS INT64)');
});

test('translate: STARTS_WITH passes through (DuckDB has it natively)', () => {
  const { sql } = translate("STARTS_WITH(col, 'pre')");
  assert.equal(norm(sql), "STARTS_WITH(col, 'pre')");
});

test('translate: ENDS_WITH passes through', () => {
  const { sql } = translate("ENDS_WITH(col, 'post')");
  assert.equal(norm(sql), "ENDS_WITH(col, 'post')");
});

// ---------------------------------------------------------------------------
// Unsupported BigQuery features
// ---------------------------------------------------------------------------

test('translate: FARM_FINGERPRINT throws unsupportedFeature', () => {
  assert.throws(
    () => translate('SELECT FARM_FINGERPRINT(col) FROM t'),
    (err: unknown) =>
      err instanceof BqError &&
      err.reason === 'unsupportedFeature' &&
      /FARM_FINGERPRINT/.test(err.message),
  );
});

test('translate: APPROX_COUNT_DISTINCT throws unsupportedFeature', () => {
  assert.throws(
    () => translate('SELECT APPROX_COUNT_DISTINCT(col) FROM t'),
    (err: unknown) => err instanceof BqError && err.reason === 'unsupportedFeature',
  );
});

test('translate: GENERATE_UUID throws unsupportedFeature', () => {
  assert.throws(
    () => translate('SELECT GENERATE_UUID()'),
    (err: unknown) => err instanceof BqError && err.reason === 'unsupportedFeature',
  );
});

// ---------------------------------------------------------------------------
// Pass-through / safety
// ---------------------------------------------------------------------------

test('translate: identifiers that share names with BQ functions but are NOT called are kept', () => {
  const { sql } = translate('SELECT current_timestamp AS x FROM t');
  assert.equal(norm(sql), 'SELECT current_timestamp AS x FROM t');
});

test('translate: comment containing TIMESTAMP_SUB( is not rewritten', () => {
  const { sql } = translate('/* TIMESTAMP_SUB(...) */ SELECT 1');
  assert.equal(norm(sql), '/* TIMESTAMP_SUB(...) */ SELECT 1');
});

test('translate: string containing @name is not parameterized', () => {
  const { sql, paramOrder } = translate("SELECT '@notparam' FROM t");
  assert.equal(norm(sql), "SELECT '@notparam' FROM t");
  assert.deepEqual(paramOrder, []);
});

test('translate: unbalanced parentheses throw invalid', () => {
  assert.throws(
    () => translate('TIMESTAMP_SUB(col, INTERVAL 1 DAY'),
    (err: unknown) => err instanceof BqError && err.reason === 'invalid',
  );
});

// ---------------------------------------------------------------------------
// Realistic v0 reference query
// ---------------------------------------------------------------------------

test('translate: realistic v0 reference query rewrites cleanly', () => {
  const input = `
    SELECT
      e.id AS event_id,
      JSON_VALUE(e.payload, '$.licenses."us-east"') AS license,
      TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY) AS cutoff
    FROM \`my-project.dataset.events\` e
    WHERE STARTS_WITH(e.type, 'drops.')
      AND e.id IN UNNEST(@ids)
      AND e.created_at >= @since
    ORDER BY e.created_at ASC
  `;
  const { sql, paramOrder } = translate(input);
  const got = norm(sql);
  assert.match(got, /"dataset"\."events"/);
  assert.match(got, /json_extract_string\(e\.payload, '\$\.licenses\."us-east"'\)/);
  assert.match(got, /\(CURRENT_TIMESTAMP - INTERVAL 7 DAY\)/);
  assert.match(got, /STARTS_WITH\(e\.type, 'drops\.'\)/);
  assert.match(got, /UNNEST\(\$1\)/);
  assert.match(got, /e\.created_at >= \$2/);
  assert.deepEqual(paramOrder, ['ids', 'since']);
});
