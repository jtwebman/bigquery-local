/**
 * Seed-file loader for `--data-from-yaml=path.yaml`.
 *
 * Format (per the public docs):
 *
 *   datasets:
 *     - project: my-project    # optional; defaults to "local"
 *       datasetId: analytics
 *       location: US           # optional
 *       tables:
 *         - tableId: events
 *           schema:
 *             fields:
 *               - { name: id, type: STRING, mode: REQUIRED }
 *               - { name: ts, type: TIMESTAMP }
 *           rows:              # optional
 *             - { id: "a", ts: "2026-05-01T00:00:00Z" }
 *             - { id: "b", ts: "2026-05-02T00:00:00Z" }
 *
 * The loader drives the same `POST /datasets` / `POST /tables` /
 * `POST /insertAll` paths an HTTP client would. Any error short-circuits
 * the whole load and surfaces with the offending path in the message.
 */

import { readFileSync } from 'node:fs';

import yaml from 'js-yaml';

import { BqError } from './util/errors.ts';

export interface SeedFieldSpec {
  readonly name: string;
  readonly type: string;
  readonly mode?: 'NULLABLE' | 'REQUIRED' | 'REPEATED';
  readonly description?: string;
  readonly fields?: readonly SeedFieldSpec[];
}

export interface SeedTableSpec {
  readonly tableId: string;
  readonly schema: { readonly fields: readonly SeedFieldSpec[] };
  readonly rows?: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly description?: string;
}

export interface SeedDatasetSpec {
  readonly project?: string;
  readonly datasetId: string;
  readonly location?: string;
  readonly description?: string;
  readonly tables?: readonly SeedTableSpec[];
}

export interface SeedDoc {
  readonly datasets: readonly SeedDatasetSpec[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function asObject(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw BqError.invalid(`${path} must be a YAML mapping.`, path);
  }
  return value as Readonly<Record<string, unknown>>;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw BqError.invalid(`${path} must be a string.`, path);
  }
  return value;
}

function asStringOpt(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return asString(value, path);
}

function asArray<T>(value: unknown, path: string, item: (v: unknown, p: string) => T): T[] {
  if (!Array.isArray(value)) {
    throw BqError.invalid(`${path} must be a YAML sequence.`, path);
  }
  return value.map((v, i) => item(v, `${path}[${i}]`));
}

function parseField(value: unknown, path: string): SeedFieldSpec {
  const obj = asObject(value, path);
  const result: {
    name: string;
    type: string;
    mode?: 'NULLABLE' | 'REQUIRED' | 'REPEATED';
    description?: string;
    fields?: readonly SeedFieldSpec[];
  } = {
    name: asString(obj['name'], `${path}.name`),
    type: asString(obj['type'], `${path}.type`),
  };
  const mode = asStringOpt(obj['mode'], `${path}.mode`);
  if (mode !== undefined) {
    if (mode !== 'NULLABLE' && mode !== 'REQUIRED' && mode !== 'REPEATED') {
      throw BqError.invalid(
        `${path}.mode must be one of NULLABLE, REQUIRED, REPEATED.`,
        `${path}.mode`,
      );
    }
    result.mode = mode;
  }
  const description = asStringOpt(obj['description'], `${path}.description`);
  if (description !== undefined) result.description = description;
  if (obj['fields'] !== undefined) {
    result.fields = asArray(obj['fields'], `${path}.fields`, parseField);
  }
  return result;
}

function parseTable(value: unknown, path: string): SeedTableSpec {
  const obj = asObject(value, path);
  const schemaRaw = obj['schema'];
  if (schemaRaw === undefined) {
    throw BqError.invalid(`${path}.schema is required.`, `${path}.schema`);
  }
  const schemaObj = asObject(schemaRaw, `${path}.schema`);
  const fields = asArray(schemaObj['fields'], `${path}.schema.fields`, parseField);
  const result: {
    tableId: string;
    schema: { fields: readonly SeedFieldSpec[] };
    rows?: ReadonlyArray<Readonly<Record<string, unknown>>>;
    description?: string;
  } = {
    tableId: asString(obj['tableId'], `${path}.tableId`),
    schema: { fields },
  };
  const description = asStringOpt(obj['description'], `${path}.description`);
  if (description !== undefined) result.description = description;
  if (obj['rows'] !== undefined) {
    result.rows = asArray(obj['rows'], `${path}.rows`, (v, p) => asObject(v, p));
  }
  return result;
}

function parseDataset(value: unknown, path: string): SeedDatasetSpec {
  const obj = asObject(value, path);
  const result: {
    project?: string;
    datasetId: string;
    location?: string;
    description?: string;
    tables?: readonly SeedTableSpec[];
  } = {
    datasetId: asString(obj['datasetId'], `${path}.datasetId`),
  };
  const project = asStringOpt(obj['project'], `${path}.project`);
  if (project !== undefined) result.project = project;
  const location = asStringOpt(obj['location'], `${path}.location`);
  if (location !== undefined) result.location = location;
  const description = asStringOpt(obj['description'], `${path}.description`);
  if (description !== undefined) result.description = description;
  if (obj['tables'] !== undefined) {
    result.tables = asArray(obj['tables'], `${path}.tables`, parseTable);
  }
  return result;
}

export function parseSeedDoc(yamlText: string): SeedDoc {
  let raw: unknown;
  try {
    raw = yaml.load(yamlText);
  } catch (err) {
    throw BqError.invalid(
      `Seed YAML failed to parse: ${err instanceof Error ? err.message : 'unknown error'}`,
      'data-from-yaml',
    );
  }
  const obj = asObject(raw, 'seed');
  const datasets = asArray(obj['datasets'] ?? [], 'seed.datasets', parseDataset);
  return { datasets };
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/** Apply a parsed seed doc to a running server. `baseUrl` is the server's
 * `url` (e.g. `http://localhost:9050`). `defaultProject` is what gets used
 * for datasets that don't specify `project` (typically the CLI's first
 * `--project` flag). */
export async function loadSeed(
  baseUrl: string,
  doc: SeedDoc,
  defaultProject: string,
): Promise<void> {
  for (const ds of doc.datasets) {
    const project = ds.project ?? defaultProject;

    // Dataset.
    const dsBody: Record<string, unknown> = {
      datasetReference: { datasetId: ds.datasetId },
    };
    if (ds.location !== undefined) dsBody['location'] = ds.location;
    if (ds.description !== undefined) dsBody['description'] = ds.description;
    await post(
      `${baseUrl}/projects/${project}/datasets`,
      dsBody,
      `dataset ${project}:${ds.datasetId}`,
    );

    for (const t of ds.tables ?? []) {
      // Table.
      const tableBody: Record<string, unknown> = {
        tableReference: { tableId: t.tableId },
        schema: t.schema,
      };
      if (t.description !== undefined) tableBody['description'] = t.description;
      await post(
        `${baseUrl}/projects/${project}/datasets/${ds.datasetId}/tables`,
        tableBody,
        `table ${project}:${ds.datasetId}.${t.tableId}`,
      );

      // Rows.
      if (t.rows !== undefined && t.rows.length > 0) {
        await post(
          `${baseUrl}/projects/${project}/datasets/${ds.datasetId}/tables/${t.tableId}/insertAll`,
          { rows: t.rows.map((r) => ({ json: r })) },
          `rows for ${project}:${ds.datasetId}.${t.tableId}`,
        );
      }
    }
  }
}

async function post(url: string, body: unknown, label: string): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Seed step "${label}" failed (HTTP ${res.status}): ${errBody}`);
  }
}

/** Load a seed file from disk. */
export async function loadSeedFromFile(
  baseUrl: string,
  path: string,
  defaultProject: string,
): Promise<void> {
  const yamlText = readFileSync(path, 'utf8');
  const doc = parseSeedDoc(yamlText);
  await loadSeed(baseUrl, doc, defaultProject);
}
