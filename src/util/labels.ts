/**
 * Label-map parsing helpers shared across tables, jobs, datasets, models,
 * and routines.
 *
 * BigQuery's REST API treats the `labels` field as a top-level replace:
 * when present in a PATCH body, the entire labels map is replaced by
 * the value in the body (and when absent, existing labels are preserved
 * — that's the responsibility of the caller, not this helper).
 *
 * Where this differs from a naive parser is that **null values inside
 * the labels map are allowed** — they're interpreted as "this key is
 * not part of the new labels," matching the convention Google's Go
 * client uses to express label deletion (via `NullFields =
 * ["Labels.<key>"]` which serializes as an explicit JSON null).
 *
 * Python's `update_table(table, ["labels"])` sends the full target
 * labels dict with no nulls and relies on the replace semantic — also
 * supported here. So both client patterns work.
 */

import { BqError } from './errors.ts';

/**
 * Parse a `labels` map. Accepts string values (kept) and null values
 * (filtered out — see module docstring). Returns the filtered map ready
 * to be stored as the new value of the resource's labels field.
 */
export function expectLabels(value: unknown, field: string): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw BqError.invalid(`${field} must be an object of string keys and string values.`, field);
  }
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null) {
      // Null values are the "delete this key" marker the Go client uses
      // via NullFields = ["Labels.<key>"]. Under replace semantics, the
      // key just isn't part of the new labels map — drop it silently.
      continue;
    }
    if (typeof v !== 'string') {
      throw BqError.invalid(`${field}.${k} must be a string.`, `${field}.${k}`);
    }
    result[k] = v;
  }
  return result;
}
