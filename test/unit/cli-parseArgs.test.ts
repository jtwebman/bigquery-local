import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { parseArgs } from '../../src/cli.ts';

test('parseArgs returns defaults for empty argv', () => {
  const { options, exit } = parseArgs([]);
  assert.equal(exit, undefined);
  assert.deepEqual(options.projects, ['local']);
  assert.equal(options.port, 9050);
  assert.equal(options.grpcPort, 9060);
  assert.equal(options.database, ':memory:');
  assert.equal(options.logLevel, 'info');
  assert.equal(options.logFormat, 'text');
  assert.equal(options.dataFromYaml, undefined);
});

test('parseArgs --help returns a usage exit message', () => {
  const result = parseArgs(['--help']);
  assert.match(result.exit ?? '', /Usage: bigquery-local/);
});

test('parseArgs -h returns a usage exit message', () => {
  const result = parseArgs(['-h']);
  assert.match(result.exit ?? '', /Usage: bigquery-local/);
});

test('parseArgs --version returns a version exit message', () => {
  const result = parseArgs(['--version']);
  assert.match(result.exit ?? '', /^\d+\.\d+\.\d+/);
});

test('parseArgs -v returns a version exit message', () => {
  const result = parseArgs(['-v']);
  assert.match(result.exit ?? '', /^\d+\.\d+\.\d+/);
});

test('parseArgs accepts every documented flag', () => {
  const { options } = parseArgs([
    '--project=alpha',
    '--port=0',
    '--grpc-port=12345',
    '--database=/tmp/bq.duckdb',
    '--log-level=debug',
    '--log-format=json',
    '--data-from-yaml=./seed.yaml',
  ]);
  assert.deepEqual(options.projects, ['alpha']);
  assert.equal(options.port, 0);
  assert.equal(options.grpcPort, 12345);
  assert.equal(options.database, '/tmp/bq.duckdb');
  assert.equal(options.logLevel, 'debug');
  assert.equal(options.logFormat, 'json');
  assert.equal(options.dataFromYaml, './seed.yaml');
});

test('parseArgs throws on unknown flag', () => {
  assert.throws(() => parseArgs(['--mystery=1']), /Unknown flag: --mystery/);
});

test('parseArgs throws on positional argument', () => {
  assert.throws(() => parseArgs(['hello']), /Unknown argument: "hello"/);
});

test('parseArgs throws when --flag has no value', () => {
  assert.throws(() => parseArgs(['--port']), /requires a value/);
});

test('parseArgs throws on non-integer port', () => {
  assert.throws(() => parseArgs(['--port=abc']), /must be a non-negative integer/);
});

test('parseArgs throws on negative grpc-port', () => {
  assert.throws(() => parseArgs(['--grpc-port=-1']), /must be a non-negative integer/);
});

test('parseArgs collects repeated --project flags in order', () => {
  const { options } = parseArgs(['--project=foo', '--project=bar', '--project=baz']);
  assert.deepEqual(options.projects, ['foo', 'bar', 'baz']);
});

test('parseArgs --project replaces the default on first use, then appends', () => {
  // Without any flag: default `['local']`. First `--project=foo` replaces it
  // (so we don't end up with `['local', 'foo']`). Subsequent flags append.
  const { options } = parseArgs(['--project=foo', '--project=bar']);
  assert.deepEqual(options.projects, ['foo', 'bar']);
});

test('parseArgs rejects an empty --project value', () => {
  assert.throws(() => parseArgs(['--project=']), /--project requires a non-empty value/);
});
