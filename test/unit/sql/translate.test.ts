import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { translate } from '../../../src/sql/translate.ts';
import { BqError } from '../../../src/util/errors.ts';

function norm(sql: string): string {
  // Collapse whitespace for easier comparison.
  return sql.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// String literals: BQ `"..."` is a string (DuckDB identifier quote);
// escapes are interpreted (DuckDB `'...'` does not).
// ---------------------------------------------------------------------------

test('translate: double-quoted string becomes a single-quoted literal', () => {
  assert.equal(norm(translate('SELECT "hello"', { project: 'p' }).sql), "SELECT 'hello'");
});

test('translate: apostrophe inside a double-quoted string is doubled', () => {
  assert.equal(norm(translate(`SELECT "it's"`, { project: 'p' }).sql), "SELECT 'it''s'");
});

test('translate: double-quote inside a single-quoted string survives', () => {
  assert.equal(norm(translate(`SELECT 'say "hi"'`, { project: 'p' }).sql), 'SELECT \'say "hi"\'');
});

test('translate: backslash escapes decode (\\n \\t \\r \\b \\f \\v \\a)', () => {
  const { sql } = translate("SELECT '\\n\\t\\r\\b\\f\\v\\a'", { project: 'p' });
  // Each escape decodes to its control char, then re-emits inside '...'.
  assert.equal(sql, "SELECT '\n\t\r\b\f\v\x07'");
});

test('translate: hex / unicode escapes decode', () => {
  assert.equal(norm(translate("SELECT '\\x41\\x42'", { project: 'p' }).sql), "SELECT 'AB'");
  assert.equal(
    norm(translate("SELECT '\\u0041\\u0042\\u0043'", { project: 'p' }).sql),
    "SELECT 'ABC'",
  );
  assert.equal(norm(translate("SELECT '\\U00000041'", { project: 'p' }).sql), "SELECT 'A'");
});

test('translate: octal escape decodes', () => {
  assert.equal(norm(translate("SELECT '\\101'", { project: 'p' }).sql), "SELECT 'A'");
});

test('translate: escaped quote and backslash decode', () => {
  assert.equal(norm(translate("SELECT '\\'x\\\\y'", { project: 'p' }).sql), "SELECT '''x\\y'");
});

test('translate: raw string keeps backslashes literal', () => {
  assert.equal(
    norm(translate("SELECT r'raw\\nstring'", { project: 'p' }).sql),
    "SELECT 'raw\\nstring'",
  );
});

test('translate: triple-quoted string decodes like a normal string', () => {
  assert.equal(norm(translate(`SELECT """hi"""`, { project: 'p' }).sql), "SELECT 'hi'");
});

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

test('translate: SAFE_CAST renamed to try_cast and INT64 → BIGINT in cast target', () => {
  const { sql } = translate('SAFE_CAST(col AS INT64)', { project: 'p' });
  assert.equal(norm(sql), 'try_cast(col AS BIGINT)');
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

// ---------------------------------------------------------------------------
// STRUCT() literal translation
// ---------------------------------------------------------------------------

test('translate: STRUCT(<expr> AS <name>, ...) becomes a named DuckDB struct literal', () => {
  const { sql } = translate("SELECT STRUCT(1 AS id, 'x' AS label) AS s", { project: 'p' });
  assert.match(norm(sql), /SELECT \{"id": 1, "label": 'x'\} AS s/);
});

test('translate: STRUCT named-field literal accepts complex expressions', () => {
  const { sql } = translate('SELECT STRUCT(a + b AS sum, UPPER(c) AS upper) FROM t', {
    project: 'p',
  });
  assert.match(norm(sql), /SELECT \{"sum": a \+ b, "upper": UPPER\(c\)\} FROM t/);
});

test('translate: positional STRUCT(...) falls back to a row expression', () => {
  const { sql } = translate("SELECT STRUCT(1, 'x')", { project: 'p' });
  assert.match(norm(sql), /SELECT \(1, 'x'\)/);
});

test('translate: empty STRUCT() falls back to a row expression', () => {
  const { sql } = translate('SELECT STRUCT()', { project: 'p' });
  assert.match(norm(sql), /SELECT \(\)/);
});

test('translate: mixed positional + named STRUCT falls back (no partial named form)', () => {
  // First arg is positional, second is named — translator can't emit a
  // half-named DuckDB literal, so it falls back to the positional form.
  const { sql } = translate('SELECT STRUCT(1, 2 AS b)', { project: 'p' });
  assert.match(norm(sql), /SELECT \(1, 2 AS b\)/);
});

// ---------------------------------------------------------------------------
// UNNEST table-source alias
// ---------------------------------------------------------------------------

test('translate: UNNEST(arr) AS x becomes UNNEST(...) AS _unnest_alias(x)', () => {
  const { sql } = translate('SELECT x FROM UNNEST([1, 2, 3]) AS x', { project: 'p' });
  assert.match(norm(sql), /UNNEST\(\[1, 2, 3\]\) AS _unnest_alias\("x"\)/);
});

test('translate: UNNEST without AS passes through unchanged', () => {
  const { sql } = translate('SELECT * FROM UNNEST([1, 2, 3])', { project: 'p' });
  assert.match(norm(sql), /SELECT \* FROM UNNEST\(\[1, 2, 3\]\)/);
});

test('translate: UNNEST already in DuckDB AS t(c) form passes through', () => {
  const { sql } = translate('SELECT s FROM UNNEST([1, 2]) AS t(s)', { project: 'p' });
  assert.match(norm(sql), /UNNEST\(\[1, 2\]\) AS t\(s\)/);
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

// ---------------------------------------------------------------------------
// Variadic / arithmetic function rewrites (NULL semantics)
// ---------------------------------------------------------------------------

test('translate: DIV becomes truncating integer division', () => {
  const { sql } = translate('SELECT DIV(10, 3) AS q', { project: 'p' });
  assert.match(norm(sql), /SELECT \(10 \/\/ 3\) AS q/);
});

test('translate: CONCAT becomes a NULL-propagating || chain cast to VARCHAR', () => {
  const { sql } = translate("SELECT CONCAT('a', x, 'c') AS s FROM t", { project: 'p' });
  assert.match(norm(sql), /SELECT CAST\(\('a' \|\| x \|\| 'c'\) AS VARCHAR\) AS s/);
});

test('translate: GREATEST guards NULL args (BQ propagates NULL)', () => {
  const { sql } = translate('SELECT GREATEST(a, b) AS g FROM t', { project: 'p' });
  assert.match(
    norm(sql),
    /CASE WHEN \(a\) IS NULL OR \(b\) IS NULL THEN NULL ELSE GREATEST\(a, b\) END/,
  );
});

test('translate: LEAST guards NULL args', () => {
  const { sql } = translate('SELECT LEAST(a, b, c) AS l FROM t', { project: 'p' });
  assert.match(norm(sql), /CASE WHEN .* THEN NULL ELSE LEAST\(a, b, c\) END/);
});

// ---------------------------------------------------------------------------
// SAFE_* math, EXCEPT/EXCLUDE, UNNEST WITH OFFSET, date parts
// ---------------------------------------------------------------------------

test('translate: SAFE_ADD/SUBTRACT/MULTIPLY become TRY(...)', () => {
  assert.match(norm(translate('SELECT SAFE_ADD(a, b)', { project: 'p' }).sql), /TRY\(a \+ b\)/);
  assert.match(norm(translate('SELECT SAFE_SUBTRACT(a, b)', { project: 'p' }).sql), /TRY\(a - b\)/);
  assert.match(
    norm(translate('SELECT SAFE_MULTIPLY(a, b)', { project: 'p' }).sql),
    /TRY\(a \* b\)/,
  );
});

test('translate: SAFE_NEGATE becomes TRY(-(...))', () => {
  assert.match(norm(translate('SELECT SAFE_NEGATE(x)', { project: 'p' }).sql), /TRY\(-\(x\)\)/);
});

test('translate: SELECT * EXCEPT (col) becomes * EXCLUDE (col)', () => {
  assert.match(
    norm(translate('SELECT * EXCEPT (b) FROM t', { project: 'p' }).sql),
    /\* EXCLUDE \(b\)/,
  );
});

test('translate: set-operator EXCEPT is left alone', () => {
  const { sql } = translate('SELECT a FROM t EXCEPT SELECT a FROM u', { project: 'p' });
  assert.match(norm(sql), /FROM t EXCEPT SELECT/);
});

test('translate: UNNEST WITH OFFSET becomes a parallel range unnest', () => {
  const { sql } = translate('SELECT e, i FROM UNNEST([1, 2]) AS e WITH OFFSET AS i', {
    project: 'p',
  });
  assert.match(
    norm(sql),
    /UNNEST\(\[1, 2\]\) AS "e", UNNEST\(range\(0, len\(\[1, 2\]\)\)\) AS "i"/,
  );
});

test('translate: DATE_SUB becomes (date - interval) cast to DATE', () => {
  const { sql } = translate("SELECT DATE_SUB(DATE '2025-01-01', INTERVAL 1 DAY)", { project: 'p' });
  assert.match(norm(sql), /CAST\(\(DATE '2025-01-01' - INTERVAL 1 DAY\) AS DATE\)/);
});

test('translate: DATE_TRUNC WEEK shifts to Sunday-based', () => {
  const { sql } = translate("SELECT DATE_TRUNC(DATE '2025-08-15', WEEK)", { project: 'p' });
  assert.match(
    norm(sql),
    /date_trunc\('week', DATE '2025-08-15' \+ INTERVAL 1 DAY\) - INTERVAL 1 DAY/,
  );
});

test('translate: EXTRACT(ISOWEEK) maps to week', () => {
  const { sql } = translate("SELECT EXTRACT(ISOWEEK FROM DATE '2025-01-05')", { project: 'p' });
  assert.match(norm(sql), /EXTRACT\(week FROM DATE '2025-01-05'\)/);
});

// ---------------------------------------------------------------------------
// `^` (XOR) infix → xor() rewrite
// ---------------------------------------------------------------------------

test('translate: ^ becomes xor() for simple operands', () => {
  assert.equal(norm(translate('SELECT 5 ^ 3', { project: 'p' }).sql), 'SELECT xor(5, 3)');
});

test('translate: ^ chains left-associatively', () => {
  assert.equal(
    norm(translate('SELECT 1 ^ 2 ^ 3', { project: 'p' }).sql),
    'SELECT xor(xor(1, 2), 3)',
  );
});

test('translate: ^ with parenthesized operands keeps the groups', () => {
  assert.equal(
    norm(translate('SELECT (a + 1) ^ (b + 2) FROM t', { project: 'p' }).sql),
    'SELECT xor((a + 1), (b + 2)) FROM t',
  );
});

test('translate: ^ binds member access, calls, and subscripts as primaries', () => {
  assert.equal(
    norm(translate('SELECT a.b.c ^ f(x) FROM t', { project: 'p' }).sql),
    'SELECT xor(a.b.c, f(x)) FROM t',
  );
  assert.equal(
    norm(translate('SELECT arr[0] ^ g(h(y)) FROM t', { project: 'p' }).sql),
    'SELECT xor(arr[0], g(h(y))) FROM t',
  );
});

test('translate: ^ accepts a leading unary on the right operand', () => {
  assert.equal(
    norm(translate('SELECT a ^ -b FROM t', { project: 'p' }).sql),
    'SELECT xor(a, -b) FROM t',
  );
});

test('translate: ^ takes string and parameter operands', () => {
  assert.equal(norm(translate("SELECT 'a' ^ 'b'", { project: 'p' }).sql), "SELECT xor('a', 'b')");
  const { sql } = translate('SELECT @x ^ 1', { project: 'p' });
  assert.equal(norm(sql), 'SELECT xor($1, 1)');
});

test('translate: keyword before a group is not treated as a callee', () => {
  assert.equal(
    norm(translate('SELECT x FROM t WHERE (a) ^ (b) = 0', { project: 'p' }).sql),
    'SELECT x FROM t WHERE xor((a), (b)) = 0',
  );
});

test('translate: a dangling ^ with no operand is left alone', () => {
  // No left operand (^ leads the expression) and no right operand (^ trails).
  assert.match(norm(translate('SELECT 1 + (^ 2)', { project: 'p' }).sql), /\^/);
  assert.match(norm(translate('SELECT 2 ^', { project: 'p' }).sql), /\^/);
});

// ---------------------------------------------------------------------------
// Decimal literals → FLOAT64 (BQ types bare `3.14` as FLOAT64, not NUMERIC)
// ---------------------------------------------------------------------------

test('translate: bare decimal literal casts to DOUBLE', () => {
  assert.equal(norm(translate('SELECT 3.14', { project: 'p' }).sql), 'SELECT CAST(3.14 AS DOUBLE)');
});

test('translate: exponent literal casts to DOUBLE', () => {
  assert.equal(norm(translate('SELECT 1e3', { project: 'p' }).sql), 'SELECT CAST(1e3 AS DOUBLE)');
});

test('translate: integer literal is left as-is (INT64)', () => {
  assert.equal(norm(translate('SELECT 42', { project: 'p' }).sql), 'SELECT 42');
});

test('translate: arithmetic on decimals casts each operand', () => {
  assert.equal(
    norm(translate('SELECT 1.5 + 2.5', { project: 'p' }).sql),
    'SELECT CAST(1.5 AS DOUBLE) + CAST(2.5 AS DOUBLE)',
  );
});

test('translate: NUMERIC typed-string literal stays DECIMAL (not cast to DOUBLE)', () => {
  assert.equal(
    norm(translate("SELECT NUMERIC '123.456'", { project: 'p' }).sql),
    "SELECT CAST('123.456' AS DECIMAL(38, 9))",
  );
});

test('translate: TABLESAMPLE PERCENT value is not cast to DOUBLE', () => {
  assert.equal(
    norm(translate('SELECT * FROM t TABLESAMPLE SYSTEM (2.5 PERCENT)', { project: 'p' }).sql),
    'SELECT * FROM t TABLESAMPLE BERNOULLI (2.5 PERCENT)',
  );
});
