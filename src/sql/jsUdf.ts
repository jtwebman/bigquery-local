/**
 * BigQuery `LANGUAGE js` UDF runtime — V8 isolate via isolated-vm.
 *
 * Sandboxing model:
 *   - One Isolate per Db connection, lazily created on the first JS UDF.
 *     128 MB memory cap; the Isolate is disposed on `Db.close()`.
 *   - Each UDF body compiles inside the isolate to a `Reference<Function>`
 *     held by the host. Per-row invocation calls `Reference.applySync` with
 *     a 5000 ms CPU timeout; runaway loops surface as a `BqError` rather
 *     than hanging the emulator.
 *   - The isolate has no `process`, no `require`, no `Buffer`, no host
 *     globals. UDF code can compute on its arguments and that's it.
 *
 * Distribution model:
 *   - `isolated-vm` is an `optionalDependencies` install: the npm install
 *     succeeds whether or not the prebuilt binary matches the user's
 *     Node/platform.
 *   - If the user attempts to use `LANGUAGE js` without isolated-vm
 *     present, they get a precise error pointing them at the Docker
 *     image (which bundles a working isolated-vm) or a direct install.
 *
 * Type marshaling (BQ → JS, per the BQ JS UDF contract):
 *   - INT64 → Number          (lossy past 2^53; documented by BQ)
 *   - FLOAT64 → Number
 *   - BOOL → boolean, STRING → string
 *   - NUMERIC / BIGNUMERIC → string
 *
 * Types not yet supported as JS-UDF arguments/returns: BYTES, DATE,
 * TIME, DATETIME, TIMESTAMP, JSON, ARRAY, STRUCT. The DuckDB
 * scalar-function boundary returns those as native value objects
 * (DuckDBDateValue, DuckDBTimeValue, etc.) that don't cross the
 * isolate boundary cleanly; per-type marshaling on top of the isolate
 * boundary is more work than the v1.0 scope. If you need one of these
 * in a JS UDF, please file an issue. SQL UDFs and the rest of the
 * emulator support them as normal.
 */

import type { Db, ScalarFunctionSpec } from '../storage/db.ts';
import { BqError } from '../util/errors.ts';

// We can't statically `import 'isolated-vm'` because it's an
// `optionalDependencies` install — it may not be present at compile time
// on platforms without a prebuilt binary. To keep `tsc` happy in every
// environment (CI runners that don't install isolated-vm, end users who
// skip it), we declare the minimal API surface we need locally as
// structural types, and dynamically `import()` the module at first use.
interface IvmScript {
  runSync(context: IvmContext, opts?: { reference?: boolean; timeout?: number }): IvmReference;
  release(): void;
}
interface IvmReference {
  applySync(
    receiver: unknown,
    args: readonly unknown[],
    opts?: { result?: { copy: boolean }; timeout?: number },
  ): unknown;
  release(): void;
}
interface IvmContext {
  release(): void;
}
interface IvmIsolate {
  createContextSync(): IvmContext;
  compileScriptSync(source: string, opts?: { filename?: string }): IvmScript;
  dispose(): void;
}
interface IvmModule {
  Isolate: new (opts?: { memoryLimit?: number }) => IvmIsolate;
}

let ivmModulePromise: Promise<IvmModule | null> | null = null;
function loadIsolatedVm(): Promise<IvmModule | null> {
  if (ivmModulePromise === null) {
    ivmModulePromise = (async () => {
      try {
        // ESM-importing a CommonJS module surfaces the actual exports on
        // `.default`. Without this deref, `m.Isolate` is undefined.
        // Using a dynamic specifier string keeps tsc from trying to
        // resolve the module at compile time.
        const specifier = 'isolated-vm';
        const mod = (await import(specifier)) as { default?: IvmModule } & IvmModule;
        return mod.default !== undefined ? mod.default : (mod as IvmModule);
      } catch {
        return null;
      }
    })();
  }
  return ivmModulePromise;
}

interface JsUdfRuntime {
  readonly ivm: IvmModule;
  readonly isolate: IvmIsolate;
  readonly context: IvmContext;
  /** Compiled UDFs keyed by function name. Each is a reference to a JS
   *  function living inside the isolate. */
  readonly compiled: Map<string, IvmReference>;
}

// Per-Db runtime. The Db's onClose hook disposes the Isolate.
const RUNTIMES = new WeakMap<Db, JsUdfRuntime>();

async function ensureRuntime(db: Db): Promise<JsUdfRuntime> {
  const existing = RUNTIMES.get(db);
  if (existing !== undefined) return existing;
  const ivm = await loadIsolatedVm();
  if (ivm === null) {
    throw BqError.invalid(
      'JavaScript UDFs require the optional `isolated-vm` dependency, which is ' +
        'not installed in this environment. Either run `npm install isolated-vm` ' +
        '(needs a recent Node + C++ toolchain if no prebuild matches your platform), ' +
        'or use the bigquery-local Docker image, which bundles it.',
      'query',
    );
  }
  const isolate = new ivm.Isolate({ memoryLimit: 128 });
  const context = isolate.createContextSync();
  const runtime: JsUdfRuntime = { ivm, isolate, context, compiled: new Map() };
  RUNTIMES.set(db, runtime);
  // Release per-UDF references on Db.close(). We intentionally do NOT
  // call `runtime.isolate.dispose()` here: on Linux/Windows, calling
  // dispose after a V8 CPU timeout has fired (e.g. our sandbox infinite-
  // loop test) can block the calling thread waiting for the V8 worker
  // to finalize — observed as a 6-hour hang in CI on Ubuntu and Windows
  // runners while macOS finished in seconds. The isolate is small
  // (~tens of MB at 128 MB cap), single-instance per Db, and will be
  // reclaimed when the host process exits. References + the context
  // can be released safely.
  db.onClose(() => {
    for (const ref of runtime.compiled.values()) {
      try {
        ref.release();
      } catch {
        /* ignore — same worker-thread hazard as dispose */
      }
    }
    runtime.compiled.clear();
    try {
      runtime.context.release();
    } catch {
      /* ignore */
    }
    RUNTIMES.delete(db);
  });
  return runtime;
}

export interface JsUdfDefinition {
  readonly name: string;
  readonly argNames: readonly string[];
  /** Raw BQ type text per arg (e.g. "INT64", "STRING"). */
  readonly argBqTypes: readonly string[];
  /** Raw BQ return type text. Undefined means BQ infers — we default to STRING. */
  readonly returnBqType: string | undefined;
  /** JS body — must contain a `return` statement. */
  readonly body: string;
  /** Optional library URLs (from `OPTIONS(library=[...])`) to fetch and
   *  inject into the isolate before the UDF body runs. */
  readonly libraries?: readonly string[];
}

const DEFAULT_TIMEOUT_MS = 5000;

/** Default cap on a single library file the UDF runtime will fetch and
 *  inject. Generous for normal-sized helper modules, low enough to refuse
 *  obvious abuse. */
const MAX_LIBRARY_BYTES = 5 * 1024 * 1024;

/** Compile + register a `LANGUAGE js` UDF. Errors surface as `BqError`
 *  with location `query`. */
export async function registerJsUdf(db: Db, def: JsUdfDefinition): Promise<void> {
  // argNames + argBqTypes come from the same parsed args list upstream, so
  // they are length-equal by construction; no defensive check here.
  for (const argType of def.argBqTypes) {
    assertSupportedBqType(argType, 'argument');
  }
  assertSupportedBqType(def.returnBqType ?? 'STRING', 'return');
  const runtime = await ensureRuntime(db);

  // Optionally pre-load libraries into the isolate. Each library URL is
  // fetched, the source compiled, and run in the shared context so its
  // exports/globals become visible to subsequent UDF bodies.
  if (def.libraries !== undefined && def.libraries.length > 0) {
    for (const url of def.libraries) {
      await injectLibrary(runtime, url);
    }
  }

  // Wrap the body as `(function(arg1, arg2) { <body> })` so we can capture
  // a reference to the function and call it on demand.
  const wrappedSource = `(function(${def.argNames.join(', ')}) {\n${def.body}\n})`;
  let script: IvmScript;
  try {
    script = runtime.isolate.compileScriptSync(wrappedSource, {
      filename: `udf:${def.name}.js`,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw BqError.invalid(`JS UDF "${def.name}" failed to compile: ${msg}`, 'query');
  }
  let fnRef: IvmReference;
  try {
    fnRef = script.runSync(runtime.context, {
      reference: true,
      timeout: DEFAULT_TIMEOUT_MS,
    });
  } finally {
    script.release();
  }

  // CREATE OR REPLACE: drop the prior reference if one exists.
  const prior = runtime.compiled.get(def.name);
  if (prior !== undefined) prior.release();
  runtime.compiled.set(def.name, fnRef);

  const returnBqType = def.returnBqType ?? 'STRING';
  const spec: ScalarFunctionSpec = {
    name: def.name,
    argTypes: def.argBqTypes.map(bqTypeToDuckTypeText),
    returnType: bqTypeToDuckTypeText(returnBqType),
    callback(rawArgs) {
      const jsArgs = rawArgs.map((v, i) => duckToJsValue(v, def.argBqTypes[i] as string));
      // All supported types are primitives (Number / bigint / string /
      // boolean / null) on the host side — isolated-vm copies them across
      // the boundary directly without ExternalCopy.
      const isolateArgs = jsArgs;
      let result: unknown;
      try {
        result = fnRef.applySync(undefined, isolateArgs, {
          result: { copy: true },
          timeout: DEFAULT_TIMEOUT_MS,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Timeout gets a friendlier message because the raw isolated-vm
        // text ("Script execution timed out") doesn't say which UDF.
        // Memory-limit / generic errors fall through with the raw msg
        // — it already mentions "isolate" and the user has the UDF name.
        if (/timeout|timed out/i.test(msg)) {
          throw new Error(`UDF "${def.name}" timed out after ${DEFAULT_TIMEOUT_MS}ms`);
        }
        throw new Error(`UDF "${def.name}": ${msg}`);
      }
      return jsValueToDuck(result, returnBqType);
    },
  };
  db.registerScalarFunction(spec);
}

/** Fetch a library URL and inject its source into the isolate context. */
async function injectLibrary(runtime: JsUdfRuntime, url: string): Promise<void> {
  let source: string;
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_LIBRARY_BYTES) {
      throw new Error(`Library exceeds ${MAX_LIBRARY_BYTES}-byte limit (${buf.byteLength} bytes).`);
    }
    source = new TextDecoder('utf-8').decode(buf);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw BqError.invalid(`Failed to fetch UDF library ${url}: ${msg}`, 'query');
  }
  const script = runtime.isolate.compileScriptSync(source, { filename: url });
  try {
    script.runSync(runtime.context, { timeout: DEFAULT_TIMEOUT_MS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw BqError.invalid(`UDF library ${url} threw during load: ${msg}`, 'query');
  } finally {
    script.release();
  }
}

/** BQ types the JS-UDF runtime supports as arguments or return values.
 *  Other types reject at CREATE FUNCTION time rather than silently
 *  producing wrong values. */
const SUPPORTED_BQ_TYPES = new Set([
  'INT64',
  'INTEGER',
  'FLOAT64',
  'FLOAT',
  'BOOL',
  'BOOLEAN',
  'STRING',
  'NUMERIC',
  'BIGNUMERIC',
]);

function assertSupportedBqType(bqType: string, role: 'argument' | 'return'): void {
  const upper = bqType.trim().toUpperCase();
  if (!SUPPORTED_BQ_TYPES.has(upper)) {
    throw BqError.invalid(
      `JS UDF ${role} type "${bqType}" is not yet supported. Supported types: ` +
        `${[...SUPPORTED_BQ_TYPES].join(', ')}.`,
      'query',
    );
  }
}

/** Map a supported BQ type → DuckDB type text for `Db.registerScalarFunction`.
 *  `assertSupportedBqType` runs upstream, so every input matches a branch. */
function bqTypeToDuckTypeText(bqType: string): string {
  const upper = bqType.trim().toUpperCase();
  if (upper === 'INT64' || upper === 'INTEGER') return 'BIGINT';
  if (upper === 'FLOAT64' || upper === 'FLOAT') return 'DOUBLE';
  if (upper === 'BOOL' || upper === 'BOOLEAN') return 'BOOLEAN';
  if (upper === 'STRING') return 'VARCHAR';
  // The only remaining supported pair is NUMERIC / BIGNUMERIC.
  return 'DECIMAL(38, 9)';
}

/** DuckDB → JS value marshaling for the supported types. Callers (i.e.
 *  registerJsUdf via assertSupportedBqType) guarantee `bqType` is one of
 *  the supported set, so no `default` branch is needed. */
function duckToJsValue(value: unknown, bqType: string): unknown {
  if (value === null) return null;
  const upper = bqType.trim().toUpperCase();
  if (upper === 'INT64' || upper === 'INTEGER') {
    // BQ contract: INT64 surfaces as Number; precision loss past 2^53
    // is documented and accepted.
    return Number(value as bigint | number);
  }
  if (upper === 'FLOAT64' || upper === 'FLOAT') return Number(value);
  if (upper === 'BOOL' || upper === 'BOOLEAN') return Boolean(value);
  // STRING / NUMERIC / BIGNUMERIC — string-shaped on the BQ wire.
  return typeof value === 'string' ? value : String(value);
}

/** JS → DuckDB value marshaling for the supported return types. */
function jsValueToDuck(value: unknown, bqType: string): unknown {
  if (value === null || value === undefined) return null;
  const upper = bqType.trim().toUpperCase();
  if (upper === 'INT64' || upper === 'INTEGER') {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') return BigInt(Math.trunc(value));
    return BigInt(String(value));
  }
  if (upper === 'FLOAT64' || upper === 'FLOAT') return Number(value);
  if (upper === 'BOOL' || upper === 'BOOLEAN') return Boolean(value);
  // STRING / NUMERIC / BIGNUMERIC — string-shaped on the wire.
  return typeof value === 'string' ? value : String(value);
}
