#!/usr/bin/env node
/**
 * bigquery-local CLI entry point.
 *
 * Boots an HTTP server that speaks the BigQuery REST API on `--port`, backed
 * by a DuckDB instance at `--database` (defaults to in-memory). The server
 * runs until SIGTERM/SIGINT, at which point it stops accepting new connections,
 * lets in-flight requests finish, then closes the database handle.
 *
 * `--grpc-port` is parsed and forwarded for the future Storage Read API
 * binding (BL-019); at v0 it is unused. `--log-level` and `--log-format` are
 * also parsed for forward-compat — they are used the moment a logging layer
 * lands. `--data-from-yaml` is reserved for seed-data loading.
 */
import { pathToFileURL } from 'node:url';

import { createServer } from '../src/index.ts';

const VERSION = '0.0.1';

const USAGE = `Usage: bigquery-local [options]

Options:
  --project=<id>         Default project id (informational; routes accept any).
  --port=<n>             REST API port (default: 9050; 0 = pick a free port).
  --grpc-port=<n>        Storage Read API port placeholder (default: 9060).
  --database=<path>      DuckDB file path (default: ":memory:").
  --log-level=<level>    debug | info | warn | error (default: info).
  --log-format=<fmt>     json | text (default: text).
  --data-from-yaml=<f>   Seed data file (reserved; not yet implemented).
  -v, --version          Print version and exit.
  -h, --help             Print this help text and exit.
`;

interface CliOptions {
  project: string;
  port: number;
  grpcPort: number;
  database: string;
  logLevel: string;
  logFormat: string;
  dataFromYaml: string | undefined;
}

const DEFAULTS: CliOptions = {
  project: 'local',
  port: 9050,
  grpcPort: 9060,
  database: ':memory:',
  logLevel: 'info',
  logFormat: 'text',
  dataFromYaml: undefined,
};

function parseInt10(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${flag} must be a non-negative integer (got "${raw}").`);
  }
  return n;
}

export function parseArgs(argv: readonly string[]): { options: CliOptions; exit?: string } {
  const options: CliOptions = { ...DEFAULTS };
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') return { options, exit: USAGE };
    if (arg === '-v' || arg === '--version') return { options, exit: `${VERSION}\n` };
    if (!arg.startsWith('--')) {
      throw new Error(`Unknown argument: "${arg}". Run --help for usage.`);
    }
    const eq = arg.indexOf('=');
    if (eq === -1) {
      throw new Error(`Flag "${arg}" requires a value (use --flag=value).`);
    }
    const key = arg.slice(2, eq);
    const value = arg.slice(eq + 1);
    switch (key) {
      case 'project':
        options.project = value;
        break;
      case 'port':
        options.port = parseInt10(value, '--port');
        break;
      case 'grpc-port':
        options.grpcPort = parseInt10(value, '--grpc-port');
        break;
      case 'database':
        options.database = value;
        break;
      case 'log-level':
        options.logLevel = value;
        break;
      case 'log-format':
        options.logFormat = value;
        break;
      case 'data-from-yaml':
        options.dataFromYaml = value;
        break;
      default:
        throw new Error(`Unknown flag: --${key}. Run --help for usage.`);
    }
  }
  return { options };
}

async function main(): Promise<void> {
  let parsed: { options: CliOptions; exit?: string };
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(2);
  }
  if (parsed.exit !== undefined) {
    process.stdout.write(parsed.exit);
    process.exit(0);
  }
  const { options } = parsed;

  const server = await createServer({ database: options.database });
  await server.listen(options.port);
  process.stdout.write(
    `bigquery-local ${VERSION} listening on ${server.url} (project=${options.project}, database=${options.database})\n`,
  );

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`Received ${signal}, shutting down...\n`);
    void (async () => {
      try {
        await server.close();
        process.exit(0);
      } catch (err) {
        /* node:coverage ignore next 3 */
        process.stderr.write(`Shutdown error: ${(err as Error).message}\n`);
        process.exit(1);
      }
    })();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Only auto-run when invoked directly (so unit tests can import `parseArgs`
// without booting the server as a side effect).
const entryUrl = pathToFileURL(process.argv[1] ?? '').href;
if (import.meta.url === entryUrl) {
  void main();
}
