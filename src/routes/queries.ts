/**
 * `jobs.query` — synchronous query endpoint.
 *
 *   POST /projects/{p}/queries
 *
 * Request (BigQuery wire shape):
 *
 *     { "query": "SELECT …",
 *       "parameterMode": "NAMED",
 *       "queryParameters": [
 *         { "name": "since",
 *           "parameterType": { "type": "TIMESTAMP" },
 *           "parameterValue": { "value": "2026-05-01T00:00:00Z" } },
 *         { "name": "ids",
 *           "parameterType": { "type": "ARRAY", "arrayType": { "type": "STRING" } },
 *           "parameterValue": { "arrayValues": [ { "value": "a" }, { "value": "b" } ] } }
 *       ] }
 *
 * Response:
 *
 *     { "kind": "bigquery#queryResponse",
 *       "schema": { "fields": [ ... ] },
 *       "jobReference": { "projectId", "jobId", "location" },
 *       "totalRows": "<n>",
 *       "rows": [ { "f": [ { "v": "..." }, ... ] } ],
 *       "totalBytesProcessed": "0",
 *       "jobComplete": true,
 *       "cacheHit": false }
 *
 * v0 path is fully synchronous — translate the BQ SQL via BL-014, bind
 * the parameter values to the DuckDB \$N placeholders, execute, and
 * shape the result into BQ wire form. Each query is also persisted as a
 * \`DONE\` row in \`_bq.jobs\` (with its rows in \`_bq.job_rows\`) so
 * BL-016's \`getQueryResults\` polling endpoint works against the same
 * data.
 */

import { randomUUID } from 'node:crypto';

import type { Db, QueryResult } from '../storage/db.ts';
import { upsertJob } from '../storage/meta.ts';
import {
  type BqField,
  type BqMode,
  type BqType,
  bqTypeToDuck,
  duckTypeToBq,
  duckValueToBq,
  normalizeBqType,
} from '../storage/types.ts';
import { translate } from '../sql/translate.ts';
import type { RouteDefinition, RouteResponse } from '../types.ts';
import { BqError } from '../util/errors.ts';

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

interface FieldWire {
  readonly name: string;
  readonly type: string;
  readonly mode?: BqMode;
  readonly fields?: readonly FieldWire[];
}

interface QueryResponseWire {
  readonly kind: 'bigquery#queryResponse';
  readonly schema: { readonly fields: readonly FieldWire[] };
  readonly jobReference: {
    readonly projectId: string;
    readonly jobId: string;
    readonly location: string;
  };
  readonly totalRows: string;
  readonly rows: ReadonlyArray<{ readonly f: ReadonlyArray<{ readonly v: unknown }> }>;
  readonly totalBytesProcessed: string;
  readonly jobComplete: true;
  readonly cacheHit: false;
}

function fieldToWire(field: BqField): FieldWire {
  return {
    name: field.name,
    type: field.type,
    ...(field.mode !== undefined && { mode: field.mode }),
    ...(field.fields !== undefined && { fields: field.fields.map(fieldToWire) }),
  };
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

function asObject(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw BqError.invalid(`${path} must be a JSON object.`, path);
  }
  return value as Readonly<Record<string, unknown>>;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw BqError.invalid(`${path} must be a string.`, path);
  }
  return value;
}

interface QueryParameterParsed {
  readonly name: string;
  readonly type: BqType;
  readonly arrayElementType?: BqType;
  /** Raw scalar value when `parameterValue.value` is set. */
  readonly scalar?: string;
  /** Raw element scalars when `parameterValue.arrayValues` is set. */
  readonly arrayScalars?: readonly string[];
}

interface ParsedQueryBody {
  readonly query: string;
  readonly parameters: readonly QueryParameterParsed[];
}

function parseQueryParameter(raw: unknown, path: string): QueryParameterParsed {
  const obj = asObject(raw, path);
  const name = expectString(obj['name'], `${path}.name`);
  const typeObj = asObject(obj['parameterType'], `${path}.parameterType`);
  const isArray =
    expectString(typeObj['type'], `${path}.parameterType.type`).toUpperCase() === 'ARRAY';
  const valueObj = asObject(obj['parameterValue'], `${path}.parameterValue`);

  if (isArray) {
    const elementTypeObj = asObject(typeObj['arrayType'], `${path}.parameterType.arrayType`);
    const elementType = normalizeBqType(
      expectString(elementTypeObj['type'], `${path}.parameterType.arrayType.type`),
    );
    const arrRaw = valueObj['arrayValues'];
    if (!Array.isArray(arrRaw)) {
      throw BqError.invalid(
        `${path}.parameterValue.arrayValues must be an array.`,
        `${path}.parameterValue.arrayValues`,
      );
    }
    const arrayScalars = arrRaw.map((entry, i) => {
      const entryObj = asObject(entry, `${path}.parameterValue.arrayValues[${i}]`);
      return expectString(entryObj['value'], `${path}.parameterValue.arrayValues[${i}].value`);
    });
    return { name, type: elementType, arrayElementType: elementType, arrayScalars };
  }

  const scalarType = normalizeBqType(expectString(typeObj['type'], `${path}.parameterType.type`));
  const scalar = expectString(valueObj['value'], `${path}.parameterValue.value`);
  return { name, type: scalarType, scalar };
}

function parseQueryBody(body: unknown): ParsedQueryBody {
  const obj = asObject(body, 'request body');
  const query = expectString(obj['query'], 'query');
  const rawParams = obj['queryParameters'];
  let parameters: QueryParameterParsed[] = [];
  if (rawParams !== undefined) {
    if (!Array.isArray(rawParams)) {
      throw BqError.invalid('queryParameters must be an array.', 'queryParameters');
    }
    parameters = rawParams.map((p, i) => parseQueryParameter(p, `queryParameters[${i}]`));
  }
  return { query, parameters };
}

// ---------------------------------------------------------------------------
// Parameter encoding (BQ wire → DuckDB bind value)
// ---------------------------------------------------------------------------

function encodeScalarForBind(value: string, type: BqType): unknown {
  switch (type) {
    case 'INT64':
      return BigInt(value);
    case 'FLOAT64':
      return Number(value);
    case 'BOOL':
      return value.toLowerCase() === 'true';
    case 'STRING':
    case 'BYTES':
    case 'NUMERIC':
    case 'BIGNUMERIC':
    case 'TIMESTAMP':
    case 'DATETIME':
    case 'DATE':
    case 'TIME':
    case 'JSON':
    case 'GEOGRAPHY':
      // Strings are accepted directly by DuckDB; for temporal types DuckDB
      // does the implicit cast at use site (in WHERE clauses comparing to
      // a TIMESTAMP column, etc.).
      return value;
    case 'STRUCT':
      throw BqError.invalid('STRUCT parameters are not supported in v0.', 'parameterType');
  }
}

function arrayElementForJson(value: string, type: BqType): unknown {
  switch (type) {
    case 'FLOAT64':
      return Number(value);
    case 'BOOL':
      return value.toLowerCase() === 'true';
    case 'STRUCT':
      throw BqError.invalid('STRUCT elements in ARRAY parameters are not supported in v0.');
    default:
      // STRING, INT64 (as decimal string), TIMESTAMP, etc. — all wire as strings.
      return value;
  }
}

/** Bind an ARRAY parameter as a JSON-encoded string. The route augments
 * the SQL placeholder with `::JSON::ELEMENT_TYPE[]` so DuckDB casts on
 * use. Goes through JSON because DuckDB-Node's connection.run() value
 * inference doesn't accept a plain JS array for an untyped placeholder. */
function encodeArrayForBind(values: readonly string[], elementType: BqType): string {
  return JSON.stringify(values.map((v) => arrayElementForJson(v, elementType)));
}

function arrayPlaceholderCast(elementType: BqType): string {
  const duckType = bqTypeToDuck({ name: 'x', type: elementType });
  return `::JSON::${duckType}[]`;
}

function augmentArrayCasts(
  sql: string,
  paramOrder: readonly string[],
  parameters: readonly QueryParameterParsed[],
): string {
  const byName = new Map(parameters.map((p) => [p.name, p] as const));
  let result = sql;
  for (let i = 0; i < paramOrder.length; i += 1) {
    const name = paramOrder[i] as string;
    const param = byName.get(name);
    if (param?.arrayElementType === undefined) continue;
    const cast = arrayPlaceholderCast(param.arrayElementType);
    // Replace bare `$N` occurrences with `$N<cast>`. The negative-lookahead
    // for digits avoids `$1` matching the start of `$10`. Strings/comments
    // are unlikely to contain `$N` literally; if they do they'd be edge
    // cases for v0.
    //
    // Use a function replacement: a string replacement would interpret
    // the `$N` in the result as a regex backreference and eat it.
    const placeholderNumber = i + 1;
    const pattern = new RegExp(`\\$${placeholderNumber}(?!\\d)`, 'g');
    const replacement = `$${placeholderNumber}${cast}`;
    result = result.replace(pattern, () => replacement);
  }
  return result;
}

function mapParameters(
  paramOrder: readonly string[],
  parameters: readonly QueryParameterParsed[],
): unknown[] {
  const byName = new Map(parameters.map((p) => [p.name, p] as const));
  return paramOrder.map((name) => {
    const param = byName.get(name);
    if (param === undefined) {
      throw BqError.invalid(
        `Query parameter "@${name}" is referenced in the query but not provided.`,
        `queryParameters.${name}`,
      );
    }
    if (param.arrayScalars !== undefined && param.arrayElementType !== undefined) {
      return encodeArrayForBind(param.arrayScalars, param.arrayElementType);
    }
    if (param.scalar !== undefined) {
      return encodeScalarForBind(param.scalar, param.type);
    }
    /* node:coverage ignore next 4 */
    throw BqError.invalid(`Query parameter "@${name}" has no value.`, `queryParameters.${name}`);
  });
}

// ---------------------------------------------------------------------------
// Result shaping
// ---------------------------------------------------------------------------

function buildResultSchema(
  columnNames: readonly string[],
  columnTypes: readonly string[],
): BqField[] {
  return columnNames.map((name, i) => {
    const typeStr = columnTypes[i] ?? 'VARCHAR';
    return duckTypeToBq(typeStr, name);
  });
}

function rowsToWire(
  rows: ReadonlyArray<Record<string, unknown>>,
  schema: readonly BqField[],
): ReadonlyArray<{ readonly f: ReadonlyArray<{ readonly v: unknown }> }> {
  return rows.map((row) => ({
    f: schema.map((field) => ({ v: duckValueToBq(row[field.name], field) })),
  }));
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export function createQueriesRoutes(db: Db): readonly RouteDefinition[] {
  return [
    {
      method: 'POST',
      path: '/projects/{p}/queries',
      handler: async (req) => {
        const project = req.params['p'] as string;
        const parsed = parseQueryBody(req.body);
        const translated = translate(parsed.query);
        const values = mapParameters(translated.paramOrder, parsed.parameters);

        // For each ARRAY parameter, augment its `$N` placeholder with a
        // `::JSON::T[]` cast so DuckDB knows what LIST type to materialize.
        // (The bind value is the JSON string from `encodeArrayForBind`.)
        const sqlWithCasts = augmentArrayCasts(
          translated.sql,
          translated.paramOrder,
          parsed.parameters,
        );

        // Run the query.
        let result: QueryResult;
        try {
          result = await db.queryWithSchema(sqlWithCasts, values);
        } catch (err) {
          // DuckDB-level errors surface as 400 invalid so the client sees a
          // helpful message rather than a generic 500.
          throw BqError.invalid(
            err instanceof Error ? err.message : 'Query execution failed.',
            'query',
          );
        }

        const schema = buildResultSchema(result.columnNames, result.columnTypes);
        const wireRows = rowsToWire(result.rows, schema);
        const jobId = randomUUID();
        const startedMs = Date.now();

        // Persist the job + rows so getQueryResults (BL-016) can replay them.
        await upsertJob(db, {
          project,
          jobId,
          state: 'DONE',
          statementType: 'SELECT',
          query: parsed.query,
          params: parsed.parameters,
          startedMs,
          endedMs: startedMs,
          resultSchema: { fields: schema },
          resultTotalRows: result.rows.length,
        });
        for (let i = 0; i < result.rows.length; i += 1) {
          await db.exec(
            'INSERT INTO _bq.job_rows (project, job_id, row_index, row) VALUES ($1, $2, $3::BIGINT, $4::JSON)',
            [project, jobId, BigInt(i), JSON.stringify(wireRows[i])],
          );
        }

        const body: QueryResponseWire = {
          kind: 'bigquery#queryResponse',
          schema: { fields: schema.map(fieldToWire) },
          jobReference: { projectId: project, jobId, location: 'US' },
          totalRows: String(result.rows.length),
          rows: wireRows,
          totalBytesProcessed: '0',
          jobComplete: true,
          cacheHit: false,
        };
        return { status: 200, body } satisfies RouteResponse;
      },
    },
  ];
}
