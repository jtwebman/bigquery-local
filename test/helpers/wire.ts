/**
 * Test helpers for the BigQuery wire format.
 *
 * After the v0.5.0 wire-fidelity work, REPEATED columns come back as
 * `[{"v": ...}, {"v": ...}]` per BQ spec — not the raw arrays the test
 * suite originally assumed. `unwrapV` recursively strips the `{v: ...}`
 * cell envelope so tests can keep asserting against the underlying values.
 *
 * This is a TEST utility only; production code never uses it. For wire-shape
 * assertions (test/api/sql-wire-fidelity.test.ts), use the raw value.
 */

export function unwrapV(value: unknown): unknown {
  if (Array.isArray(value)) {
    // BQ wire shape: array of cells, each `{v: ...}` with no other keys.
    const looksLikeCells = value.every(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        'v' in item &&
        Object.keys(item as object).length === 1,
    );
    if (looksLikeCells) {
      return value.map((cell) => unwrapV((cell as { v: unknown }).v));
    }
    return value.map(unwrapV);
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    'f' in value &&
    Object.keys(value as object).length === 1 &&
    Array.isArray((value as { f: unknown }).f)
  ) {
    // STRUCT wire shape: `{f: [{v: ...}, ...]}`. We can't reconstruct field
    // names without the schema, so emit a positional array (callers know
    // the field order).
    return (value as { f: Array<{ v: unknown }> }).f.map((cell) => unwrapV(cell.v));
  }
  return value;
}
