/**
 * ETag helpers.
 *
 * `etag(value)` produces a stable 16-character hex hash of the value's
 * canonical JSON representation. Two structurally-equal objects (same keys,
 * same values, regardless of key insertion order) hash to the same string.
 *
 * `checkIfMatch(currentEtag, ifMatch)` throws
 * `BqError.conditionNotMet(...)` (HTTP 412) when an `If-Match` header is
 * present and disagrees with the current resource version.
 */

import { createHash } from 'node:crypto';

import { BqError } from './errors.ts';

/**
 * Serialize `value` to a canonical JSON form:
 *   - object keys sorted lexicographically,
 *   - `undefined` properties dropped (matching `JSON.stringify`),
 *   - arrays preserved in order.
 *
 * The output is the bytes hashed to produce the ETag.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Compute the stable ETag for a value. */
export function etag(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 16);
}

/**
 * Validate an inbound `If-Match` header against the current ETag.
 * Throws `BqError.conditionNotMet(...)` (HTTP 412) on mismatch.
 * Returns silently when `ifMatch` is omitted (preconditions are optional).
 */
export function checkIfMatch(currentEtag: string, ifMatch: string | undefined): void {
  if (ifMatch === undefined) return;
  if (ifMatch === currentEtag) return;
  throw BqError.conditionNotMet(
    `If-Match precondition failed: expected ETag ${ifMatch}, got ${currentEtag}.`,
  );
}
