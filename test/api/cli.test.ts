/**
 * Acceptance test for the `bin/bigquery-local.ts` CLI.
 *
 * Spawns the bin as a real Node subprocess, parses the "listening on …" line
 * from stdout to discover the bound port, hits a route to prove the server is
 * actually serving, then sends SIGTERM and asserts a clean exit.
 *
 * Uses port 0 so multiple test runs (and CI matrix) never collide.
 */

import { strict as assert } from 'node:assert';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const BIN = join(REPO_ROOT, 'bin/bigquery-local.ts');

function spawnBin(args: readonly string[]): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [BIN, ...args], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function collectStdout(child: ChildProcessWithoutNullStreams): Promise<string> {
  let buf = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
  });
  await once(child, 'close');
  return buf;
}

async function waitForListening(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8');
      const match = buf.match(/listening on (http:\/\/[^\s]+)/);
      if (match !== null) {
        child.stdout.off('data', onData);
        resolve(match[1] as string);
      }
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => {
      reject(new Error(`bin exited before listening (code=${code}): ${buf}`));
    });
  });
}

test('--help prints usage and exits 0', async () => {
  const child = spawnBin(['--help']);
  const stdout = await collectStdout(child);
  assert.equal(child.exitCode, 0);
  assert.match(stdout, /Usage: bigquery-local/);
  assert.match(stdout, /--project=<id>/);
  assert.match(stdout, /--data-from-yaml=<f>/);
});

test('--version prints version and exits 0', async () => {
  const child = spawnBin(['--version']);
  const stdout = await collectStdout(child);
  assert.equal(child.exitCode, 0);
  assert.match(stdout, /^\d+\.\d+\.\d+/);
});

test('unknown flag exits 2 with an error message', async () => {
  const child = spawnBin(['--nope=1']);
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  await once(child, 'close');
  assert.equal(child.exitCode, 2);
  assert.match(stderr, /Unknown flag: --nope/);
});

test('--port=0 boots, serves /discovery, and exits cleanly on SIGTERM', async () => {
  const child = spawnBin(['--port=0', '--project=acceptance']);
  try {
    const baseUrl = await waitForListening(child);

    const res = await fetch(`${baseUrl}/discovery/v1/apis/bigquery/v2/rest`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { kind?: string };
    assert.equal(body.kind, 'discovery#restDescription');

    child.kill('SIGTERM');
    const [code] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
    assert.equal(code, 0);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});
