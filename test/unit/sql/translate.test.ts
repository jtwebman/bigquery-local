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

test('translate: `dataset.table` resolves to the current-project schema', () => {
  const { sql } = translate('SELECT * FROM `ds1.events`', { project: 'p' });
  assert.equal(norm(sql), 'SELECT * FROM "p__ds1"."events"');
});

test('translate: 3-part `proj.ds.tbl` uses the explicit project segment', () => {
  // Three-part backticks override the request URL's project, so cross-project
  // queries route to the right DuckDB schema.
  const { sql } = translate('SELECT * FROM `other-proj.ds.events`', { project: 'p' });
  assert.equal(norm(sql), 'SELECT * FROM "other-proj__ds"."events"');
});

test('translate: single-segment `name` becomes "name"', () => {
  const { sql } = translate('SELECT * FROM `events`', { project: 'p' });
  assert.equal(norm(sql), 'SELECT * FROM "events"');
});

test('translate: backtick identifiers inside strings are NOT touched', () => {
  const { sql } = translate("SELECT '`literal`' FROM t", { project: 'p' });
  assert.equal(norm(sql), "SELECT '`literal`' FROM t");
});

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

test('translate: @name becomes $1 and paramOrder records the name', () => {
  const { sql, paramOrder } = translate('SELECT * FROM t WHERE id = @id', { project: 'p' });
  assert.equal(norm(sql), 'SELECT * FROM t WHERE id = $1');
  assert.deepEqual(paramOrder, ['id']);
});

test('translate: multiple distinct @-params get sequential $1, $2', () => {
  const { sql, paramOrder } = translate('SELECT * FROM t WHERE id = @id AND name = @name', {
    project: 'p',
  });
  assert.equal(norm(sql), 'SELECT * FROM t WHERE id = $1 AND name = $2');
  assert.deepEqual(paramOrder, ['id', 'name']);
});

test('translate: repeated @name reuses the same $N', () => {
  const { sql, paramOrder } = translate('SELECT * FROM t WHERE a = @x OR b = @x', { project: 'p' });
  assert.equal(norm(sql), 'SELECT * FROM t WHERE a = $1 OR b = $1');
  assert.deepEqual(paramOrder, ['x']);
});

test('translate: @ inside a string is NOT a parameter', () => {
  const { sql, paramOrder } = translate("SELECT 'email@host' AS x", { project: 'p' });
  assert.equal(norm(sql), "SELECT 'email@host' AS x");
  assert.deepEqual(paramOrder, []);
});

// ---------------------------------------------------------------------------
// CURRENT_TIMESTAMP()
// ---------------------------------------------------------------------------

test('translate: CURRENT_TIMESTAMP() loses its parens', () => {
  const { sql } = translate('SELECT CURRENT_TIMESTAMP()', { project: 'p' });
  assert.equal(norm(sql), 'SELECT CURRENT_TIMESTAMP');
});

test('translate: CURRENT_TIMESTAMP (no parens) passes through unchanged', () => {
  const { sql } = translate('SELECT CURRENT_TIMESTAMP', { project: 'p' });
  assert.equal(norm(sql), 'SELECT CURRENT_TIMESTAMP');
});

// ---------------------------------------------------------------------------
// TIMESTAMP_SUB / TIMESTAMP_ADD
// ---------------------------------------------------------------------------

test('translate: TIMESTAMP_SUB(x, INTERVAL n DAY) becomes (x - INTERVAL n DAY)', () => {
  const { sql } = translate('TIMESTAMP_SUB(col, INTERVAL 7 DAY)', { project: 'p' });
  assert.equal(norm(sql), '(col - INTERVAL 7 DAY)');
});

test('translate: TIMESTAMP_ADD(x, INTERVAL n HOUR) becomes (x + INTERVAL n HOUR)', () => {
  const { sql } = translate('TIMESTAMP_ADD(col, INTERVAL 1 HOUR)', { project: 'p' });
  assert.equal(norm(sql), '(col + INTERVAL 1 HOUR)');
});

test('translate: TIMESTAMP_SUB rewrites inside larger expression', () => {
  const { sql, paramOrder } = translate(
    'WHERE created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)',
    { project: 'p' },
  );
  assert.equal(norm(sql), 'WHERE created_at >= (CURRENT_TIMESTAMP - INTERVAL 7 DAY)');
  assert.deepEqual(paramOrder, []);
});

test('translate: TIMESTAMP_SUB with a parameterized first arg', () => {
  const { sql, paramOrder } = translate('TIMESTAMP_SUB(@since, INTERVAL 1 DAY)', { project: 'p' });
  assert.equal(norm(sql), '($1 - INTERVAL 1 DAY)');
  assert.deepEqual(paramOrder, ['since']);
});

test('translate: TIMESTAMP_SUB with missing second arg throws invalid', () => {
  assert.throws(
    () => translate('TIMESTAMP_SUB(col)', { project: 'p' }),
    (err: unknown) => err instanceof BqError && err.reason === 'invalid',
  );
});

// ---------------------------------------------------------------------------
// JSON_VALUE / SAFE_CAST / STARTS_WITH / ENDS_WITH
// ---------------------------------------------------------------------------

test('translate: JSON_VALUE renamed to json_extract_string', () => {
  const { sql } = translate("JSON_VALUE(payload, '$.path')", { project: 'p' });
  assert.equal(norm(sql), "json_extract_string(payload, '$.path')");
});

test('translate: SAFE_CAST renamed to try_cast', () => {
  const { sql } = translate('SAFE_CAST(col AS INT64)', { project: 'p' });
  assert.equal(norm(sql), 'try_cast(col AS INT64)');
});

test('translate: STARTS_WITH passes through (DuckDB has it natively)', () => {
  const { sql } = translate("STARTS_WITH(col, 'pre')", { project: 'p' });
  assert.equal(norm(sql), "STARTS_WITH(col, 'pre')");
});

test('translate: IN UNNEST(@arr) becomes = ANY (@arr) for array membership', () => {
  const { sql, paramOrder } = translate('WHERE id IN UNNEST(@ids)', { project: 'p' });
  assert.match(norm(sql), /WHERE id = ANY \(\$1\)/);
  assert.deepEqual(paramOrder, ['ids']);
});

test('translate: UNNEST not preceded by IN passes through as a table function', () => {
  const { sql } = translate('SELECT * FROM UNNEST(@arr)', { project: 'p' });
  assert.match(norm(sql), /UNNEST\(\$1\)/);
});

test('translate: ENDS_WITH passes through', () => {
  const { sql } = translate("ENDS_WITH(col, 'post')", { project: 'p' });
  assert.equal(norm(sql), "ENDS_WITH(col, 'post')");
});

// ---------------------------------------------------------------------------
// Unsupported BigQuery features
// ---------------------------------------------------------------------------

test('translate: bareword reference to an unsupported function also throws', () => {
  // Even without parens (so DuckDB would otherwise treat it as a column ref),
  // we surface a friendly "feature not supported" error.
  assert.throws(
    () => translate('SELECT GENERATE_UUID FROM t', { project: 'p' }),
    (err: unknown) => err instanceof BqError && err.reason === 'unsupportedFeature',
  );
});

test('translate: CURRENT_TIMESTAMP() with comments inside the parens still rewrites', () => {
  // Exercises `areArgsEmpty`'s comment-skipping branch.
  const { sql } = translate('SELECT CURRENT_TIMESTAMP(/* a */ -- inline\n) FROM t', {
    project: 'p',
  });
  assert.match(sql, /CURRENT_TIMESTAMP/);
  assert.doesNotMatch(sql, /\(/); // no parens remain after rewrite
});

test('translate: CURRENT_TIMESTAMP with a real arg is passed through unchanged', () => {
  // Exercises `areArgsEmpty`'s "saw a non-whitespace token, return false" branch.
  // CURRENT_TIMESTAMP doesn't take args, so we pass it through and let DuckDB
  // complain — better than silently dropping the arg.
  const { sql } = translate('SELECT CURRENT_TIMESTAMP(weird_arg)', { project: 'p' });
  assert.match(sql, /CURRENT_TIMESTAMP\(\s*weird_arg\s*\)/);
});

test('translate: FARM_FINGERPRINT throws unsupportedFeature', () => {
  assert.throws(
    () => translate('SELECT FARM_FINGERPRINT(col) FROM t', { project: 'p' }),
    (err: unknown) =>
      err instanceof BqError &&
      err.reason === 'unsupportedFeature' &&
      /FARM_FINGERPRINT/.test(err.message),
  );
});

test('translate: APPROX_COUNT_DISTINCT passes through (DuckDB has it)', () => {
  // BL-045: removed from UNSUPPORTED_FUNCTIONS — DuckDB supports the same
  // name with the same single-arg signature.
  const { sql } = translate('SELECT APPROX_COUNT_DISTINCT(col) FROM t', { project: 'p' });
  assert.match(sql, /APPROX_COUNT_DISTINCT\(col\)/i);
});

test('translate: APPROX_QUANTILES still throws unsupportedFeature (deferred)', () => {
  assert.throws(
    () => translate('SELECT APPROX_QUANTILES(col, 4) FROM t', { project: 'p' }),
    (err: unknown) => err instanceof BqError && err.reason === 'unsupportedFeature',
  );
});

test('translate: GENERATE_UUID throws unsupportedFeature', () => {
  assert.throws(
    () => translate('SELECT GENERATE_UUID()', { project: 'p' }),
    (err: unknown) => err instanceof BqError && err.reason === 'unsupportedFeature',
  );
});

// ---------------------------------------------------------------------------
// Pass-through / safety
// ---------------------------------------------------------------------------

test('translate: identifiers that share names with BQ functions but are NOT called are kept', () => {
  const { sql } = translate('SELECT current_timestamp AS x FROM t', { project: 'p' });
  assert.equal(norm(sql), 'SELECT current_timestamp AS x FROM t');
});

test('translate: comment containing TIMESTAMP_SUB( is not rewritten', () => {
  const { sql } = translate('/* TIMESTAMP_SUB(...) */ SELECT 1', { project: 'p' });
  assert.equal(norm(sql), '/* TIMESTAMP_SUB(...) */ SELECT 1');
});

test('translate: string containing @name is not parameterized', () => {
  const { sql, paramOrder } = translate("SELECT '@notparam' FROM t", { project: 'p' });
  assert.equal(norm(sql), "SELECT '@notparam' FROM t");
  assert.deepEqual(paramOrder, []);
});

test('translate: unbalanced parentheses throw invalid', () => {
  assert.throws(
    () => translate('TIMESTAMP_SUB(col, INTERVAL 1 DAY', { project: 'p' }),
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
  const { sql, paramOrder } = translate(input, { project: 'p' });
  const got = norm(sql);
  assert.match(got, /"my-project__dataset"\."events"/);
  assert.match(got, /json_extract_string\(e\.payload, '\$\.licenses\."us-east"'\)/);
  assert.match(got, /\(CURRENT_TIMESTAMP - INTERVAL 7 DAY\)/);
  assert.match(got, /STARTS_WITH\(e\.type, 'drops\.'\)/);
  assert.match(got, /= ANY \(\$1\)/);
  assert.match(got, /e\.created_at >= \$2/);
  assert.deepEqual(paramOrder, ['ids', 'since']);
});

// ---------------------------------------------------------------------------
// DuckDB-reserved-but-BQ-allowed identifier auto-quoting
// ---------------------------------------------------------------------------

test('translate: bare `user` column reference gets auto-quoted for DuckDB', () => {
  const { sql } = translate('SELECT user FROM `t`', { project: 'p' });
  assert.match(norm(sql), /SELECT "user" FROM "t"/);
});

test('translate: bare `primary` and `unique` in WHERE clause auto-quote', () => {
  const { sql } = translate('SELECT * FROM `t` WHERE primary = 1 AND unique = 2', {
    project: 'p',
  });
  assert.match(norm(sql), /WHERE "primary" = 1 AND "unique" = 2/);
});

test('translate: dotted `t.user` qualifier auto-quotes the column part', () => {
  const { sql } = translate('SELECT t.user FROM `t`', { project: 'p' });
  assert.match(norm(sql), /SELECT t\."user" FROM "t"/);
});

test('translate: function-call positions are NOT auto-quoted', () => {
  const { sql } = translate('SELECT user() AS u', { project: 'p' });
  assert.match(norm(sql), /SELECT user\(\) AS u/);
});

test('translate: identifiers NOT in the safelist still pass through bare', () => {
  // PIVOT / UNPIVOT / GLOB / ILIKE / SIMILAR / TRY_CAST stay verbatim —
  // they're DuckDB clause/operator keywords whose translation depends on
  // bare emission. Auto-quoting them would break valid syntax.
  const { sql } = translate("SELECT * FROM t WHERE name ILIKE 'foo%'", { project: 'p' });
  assert.match(norm(sql), /WHERE name ILIKE 'foo%'/);
});

test('translate: full safelist auto-quotes when used as a column', () => {
  // Walk every safelist entry to make sure each branch is exercised.
  const cases = [
    'check',
    'column',
    'constraint',
    'foreign',
    'references',
    'deferrable',
    'initially',
    'analyse',
    'analyze',
    'describe',
    'summarize',
    'returning',
    'do',
    'only',
  ];
  for (const c of cases) {
    const { sql } = translate(`SELECT ${c} FROM t`, { project: 'p' });
    assert.match(norm(sql), new RegExp(`SELECT "${c}" FROM t`), `safelist entry ${c}`);
  }
});
