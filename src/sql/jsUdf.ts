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
 *   - BYTES → Uint8Array
 *   - DATE / TIMESTAMP / DATETIME → JS Date
 *   - TIME → string ("HH:MM:SS")
 *   - ARRAY<T> → JS array (recursive)
 *   - STRUCT → JS object (recursive)
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
interface IvmExternalCopy {
  copyInto(opts?: { release?: boolean }): unknown;
}
interface IvmModule {
  Isolate: new (opts?: { memoryLimit?: number }) => IvmIsolate;
  ExternalCopy: new (value: unknown) => IvmExternalCopy;
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
  // Dispose the Isolate when the Db closes. Best-effort: a leaked Isolate
  // would survive until process exit, costing ~a few MB and the V8 heap.
  db.onClose(() => {
    for (const ref of runtime.compiled.values()) {
      try {
        ref.release();
      } catch {
        /* ignore */
      }
    }
    runtime.compiled.clear();
    try {
      runtime.context.release();
    } catch {
      /* ignore */
    }
    try {
      runtime.isolate.dispose();
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
  if (def.argNames.length !== def.argBqTypes.length) {
    throw BqError.invalid('JS UDF arg names and types must align.', 'query');
  }
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
  if (prior !== undefined) {
    try {
      prior.release();
    } catch {
      /* ignore */
    }
  }
  runtime.compiled.set(def.name, fnRef);

  const returnBqType = def.returnBqType ?? 'STRING';
  const ivmModule = runtime.ivm;
  const spec: ScalarFunctionSpec = {
    name: def.name,
    argTypes: def.argBqTypes.map(bqTypeToDuckTypeText),
    returnType: bqTypeToDuckTypeText(returnBqType),
    callback(rawArgs) {
      const jsArgs = rawArgs.map((v, i) => duckToJsValue(v, def.argBqTypes[i] as string));
      // Cross the isolate boundary. Primitives can ride raw; complex values
      // (objects, arrays, typed arrays, Date) need ExternalCopy.
      const isolateArgs = jsArgs.map((v) => toIsolateArg(ivmModule, v));
      let result: unknown;
      try {
        result = fnRef.applySync(undefined, isolateArgs, {
          result: { copy: true },
          timeout: DEFAULT_TIMEOUT_MS,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/timeout/i.test(msg) || /Script execution timed out/.test(msg)) {
          throw new Error(`UDF "${def.name}" timed out after ${DEFAULT_TIMEOUT_MS}ms`);
        }
        if (/memory|allocation/i.test(msg) && /isolate/i.test(msg)) {
          throw new Error(`UDF "${def.name}" exceeded the 128 MB memory cap`);
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

/** Cross the isolate boundary for one argument. Primitives go raw; the
 *  rest needs ExternalCopy. */
function toIsolateArg(ivm: IvmModule, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === 'number' || t === 'bigint' || t === 'string' || t === 'boolean') {
    return value;
  }
  // ExternalCopy handles Date, plain objects, arrays, ArrayBuffer/TypedArray.
  return new ivm.ExternalCopy(value).copyInto({ release: true });
}

/** Map BQ type text → DuckDB type text suitable for `Db.registerScalarFunction`. */
function bqTypeToDuckTypeText(bqType: string): string {
  const upper = bqType.trim().toUpperCase();
  const m = /^ARRAY\s*<\s*(.+?)\s*>$/.exec(upper);
  if (m !== null) {
    return `${bqTypeToDuckTypeText(m[1] as string)}[]`;
  }
  switch (upper) {
    case 'INT64':
    case 'INTEGER':
      return 'BIGINT';
    case 'FLOAT64':
    case 'FLOAT':
      return 'DOUBLE';
    case 'BOOL':
    case 'BOOLEAN':
      return 'BOOLEAN';
    case 'STRING':
      return 'VARCHAR';
    case 'BYTES':
      return 'BLOB';
    case 'NUMERIC':
    case 'BIGNUMERIC':
      return 'DECIMAL(38, 9)';
    case 'DATE':
      return 'DATE';
    case 'TIME':
      return 'TIME';
    case 'TIMESTAMP':
      return 'TIMESTAMPTZ';
    case 'DATETIME':
      return 'TIMESTAMP';
    case 'JSON':
      return 'VARCHAR';
    default:
      return 'VARCHAR';
  }
}

/** DuckDB → JS value marshaling. */
function duckToJsValue(value: unknown, bqType: string): unknown {
  if (value === null || value === undefined) return null;
  const upper = bqType.trim().toUpperCase();
  if (/^ARRAY\s*<.+>$/i.test(upper)) {
    const inner = upper.replace(/^ARRAY\s*<\s*(.+)\s*>$/i, '$1');
    if (!Array.isArray(value)) return value;
    return value.map((item) => duckToJsValue(item, inner));
  }
  switch (upper) {
    case 'INT64':
    case 'INTEGER':
      // BQ contract: INT64 surfaces as Number; precision loss past 2^53
      // is documented and accepted.
      return typeof value === 'bigint' ? Number(value) : Number(value);
    case 'FLOAT64':
    case 'FLOAT':
      return Number(value);
    case 'BOOL':
    case 'BOOLEAN':
      return Boolean(value);
    case 'STRING':
    case 'JSON':
      return typeof value === 'string' ? value : String(value);
    case 'BYTES':
      if (value instanceof Uint8Array) return value;
      return new Uint8Array(value as ArrayBufferLike);
    case 'NUMERIC':
    case 'BIGNUMERIC':
      return typeof value === 'string' ? value : String(value);
    case 'DATE':
      if (value instanceof Date) return value;
      if (typeof value === 'object' && value !== null && 'days' in value) {
        const d = (value as { days: number | bigint }).days;
        return new Date(Number(d) * 86_400_000);
      }
      return value;
    case 'TIMESTAMP':
    case 'DATETIME':
      if (value instanceof Date) return value;
      if (typeof value === 'bigint') return new Date(Number(value / 1000n));
      return value;
    case 'TIME':
      return typeof value === 'string' ? value : String(value);
    default:
      return value;
  }
}

/** JS → DuckDB value marshaling for the return path. */
function jsValueToDuck(value: unknown, bqType: string): unknown {
  if (value === null || value === undefined) return null;
  const upper = bqType.trim().toUpperCase();
  if (/^ARRAY\s*<.+>$/i.test(upper)) {
    const inner = upper.replace(/^ARRAY\s*<\s*(.+)\s*>$/i, '$1');
    if (!Array.isArray(value)) {
      throw new Error(`JS UDF expected array return for ${bqType}, got ${typeof value}`);
    }
    return value.map((item) => jsValueToDuck(item, inner));
  }
  switch (upper) {
    case 'INT64':
    case 'INTEGER':
      if (typeof value === 'bigint') return value;
      if (typeof value === 'number') return BigInt(Math.trunc(value));
      return BigInt(String(value));
    case 'FLOAT64':
    case 'FLOAT':
      return Number(value);
    case 'BOOL':
    case 'BOOLEAN':
      return Boolean(value);
    case 'STRING':
    case 'JSON':
      return typeof value === 'string' ? value : String(value);
    case 'BYTES':
      return value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBufferLike);
    case 'NUMERIC':
    case 'BIGNUMERIC':
      return typeof value === 'string' ? value : String(value);
    case 'DATE':
    case 'TIMESTAMP':
    case 'DATETIME':
    case 'TIME':
      return value;
    default:
      return String(value);
  }
}
