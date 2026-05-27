import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { detectStatementType, parseTableDdl } from '../../../src/sql/ddl.ts';
import { qualifyMergeInsertValues } from '../../../src/sql/rewrite/merge.ts';

// ---------------------------------------------------------------------------
// detectStatementType — CREATE TABLE AS vs bare CREATE TABLE vs DROP TABLE
// ---------------------------------------------------------------------------

test('detectStatementType: CREATE TABLE … AS → CREATE_TABLE_AS_SELECT', () => {
  assert.equal(detectStatementType('CREATE TABLE `ds.t` AS SELECT 1'), 'CREATE_TABLE_AS_SELECT');
  assert.equal(
    detectStatementType('create or replace table `ds.t` OPTIONS() as (select 1)'),
    'CREATE_TABLE_AS_SELECT',
  );
});

test('detectStatementType: bare CREATE TABLE (no AS) stays SELECT (generic path)', () => {
  assert.equal(detectStatementType('CREATE TABLE `ds.t` (id INT64)'), 'SELECT');
});

test('detectStatementType: DROP TABLE → DROP_TABLE; DROP TABLE FUNCTION unchanged', () => {
  assert.equal(detectStatementType('DROP TABLE `ds.t`'), 'DROP_TABLE');
  assert.equal(detectStatementType('DROP TABLE IF EXISTS `ds.t`'), 'DROP_TABLE');
  assert.equal(detectStatementType('DROP TABLE FUNCTION `ds.f`'), 'DROP_TABLE_FUNCTION');
});

// ---------------------------------------------------------------------------
// parseTableDdl
// ---------------------------------------------------------------------------

test('parseTableDdl: per-segment backticks resolve project/dataset/table', () => {
  const t = parseTableDdl('CREATE TABLE `proj`.`ds`.`tbl` AS SELECT 1', 'def');
  assert.equal(t.kind, 'CREATE_TABLE_AS_SELECT');
  assert.deepEqual([t.project, t.datasetId, t.tableId], ['proj', 'ds', 'tbl']);
});

test('parseTableDdl: single-token dotted backtick also resolves', () => {
  const t = parseTableDdl('CREATE TABLE `proj.ds.tbl` AS SELECT 1', 'def');
  assert.deepEqual([t.project, t.datasetId, t.tableId], ['proj', 'ds', 'tbl']);
});

test('parseTableDdl: 2-part name uses the default project', () => {
  const t = parseTableDdl('CREATE TABLE `ds`.`tbl` AS SELECT 1', 'def');
  assert.deepEqual([t.project, t.datasetId, t.tableId], ['def', 'ds', 'tbl']);
});

test('parseTableDdl: captures OR REPLACE, PARTITION BY, CLUSTER BY, OPTIONS', () => {
  const t = parseTableDdl(
    'CREATE OR REPLACE TABLE `ds.t` PARTITION BY DATE(ts) CLUSTER BY a, b OPTIONS(x=1) AS SELECT 1 AS a, 2 AS b, CURRENT_TIMESTAMP() AS ts',
    'def',
  );
  assert.equal(t.orReplace, true);
  assert.equal(t.partitionBy, 'DATE(ts)');
  assert.deepEqual(t.clusterBy, ['a', 'b']);
  assert.equal(t.optionsText, 'x=1');
});

test('parseTableDdl: strips a trailing semicolon from the AS body', () => {
  const t = parseTableDdl('CREATE TABLE `ds.t` AS SELECT 1 AS id;', 'def');
  assert.equal(t.asQuery, 'SELECT 1 AS id');
});

test('parseTableDdl: DROP TABLE IF EXISTS sets ifExists', () => {
  const t = parseTableDdl('DROP TABLE IF EXISTS `ds.t`', 'def');
  assert.equal(t.kind, 'DROP_TABLE');
  assert.equal(t.ifExists, true);
});

test('parseTableDdl: CREATE TABLE IF NOT EXISTS sets ifNotExists', () => {
  const t = parseTableDdl('CREATE TABLE IF NOT EXISTS `ds.t` AS SELECT 1', 'def');
  assert.equal(t.ifNotExists, true);
});

// ---------------------------------------------------------------------------
// qualifyMergeInsertValues
// ---------------------------------------------------------------------------

test('qualifyMergeInsertValues: qualifies unqualified INSERT VALUES with the source alias', () => {
  const out = qualifyMergeInsertValues(
    'MERGE INTO `ds.d` AS D USING (SELECT 1 AS id) AS S ON (S.id = D.id) ' +
      'WHEN NOT MATCHED THEN INSERT (`id`) VALUES (`id`)',
  );
  assert.match(out, /VALUES \(S\.`id`\)/);
});

test('qualifyMergeInsertValues: leaves already-qualified values and function calls alone', () => {
  const out = qualifyMergeInsertValues(
    'MERGE INTO `ds.d` AS D USING (SELECT 1 AS id) AS S ON (S.id = D.id) ' +
      'WHEN NOT MATCHED THEN INSERT (id, n) VALUES (S.id, coalesce(n, 0))',
  );
  // S.id already qualified — not doubled; coalesce( is a function, not qualified;
  // its bare arg `n` is the only thing qualified.
  assert.ok(!out.includes('S.S.id'), out);
  assert.match(out, /coalesce\(S\.n, 0\)/);
});

test('qualifyMergeInsertValues: leaves NULL literal unqualified', () => {
  const out = qualifyMergeInsertValues(
    'MERGE INTO `ds.d` AS D USING (SELECT 1 AS id) AS S ON (S.id = D.id) ' +
      'WHEN NOT MATCHED THEN INSERT (id, flag) VALUES (id, NULL)',
  );
  assert.match(out, /VALUES \(S\.id, NULL\)/);
});

test('qualifyMergeInsertValues: non-MERGE statements pass through unchanged', () => {
  const sql = 'SELECT id FROM `ds.t` WHERE id IN (1, 2)';
  assert.equal(qualifyMergeInsertValues(sql), sql);
});

test('qualifyMergeInsertValues: a MERGE with no source alias is left unchanged', () => {
  const sql =
    'MERGE INTO `ds.d` USING `ds.src` ON (`ds.src`.id = `ds.d`.id) ' +
    'WHEN NOT MATCHED THEN INSERT (id) VALUES (id)';
  // No alias before ON (the source is a bare table) — we bail rather than guess.
  assert.equal(qualifyMergeInsertValues(sql), sql);
});
