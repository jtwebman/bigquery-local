/**
 * GCS read client (BL-093).
 *
 * Reads objects identified by `gs://<bucket>/<object>` URIs through the
 * GCS JSON API. The base URL comes from `process.env.STORAGE_EMULATOR_HOST`
 * when set — the same convention every Google client library follows for
 * pointing at `fake-gcs-server` or similar emulators. When the env var is
 * unset the client talks to real GCS (`https://storage.googleapis.com`);
 * authentication for real GCS is the caller's responsibility (this client
 * does not attach OAuth tokens — it only knows how to issue plain HTTP
 * GETs).
 *
 * In an emulator-paired setup (the only case our load jobs care about),
 * the host typically requires no auth and accepts unauthenticated GETs.
 *
 * Scope is deliberately small:
 *   - `gs://...` URI parsing
 *   - object metadata (`size`, `contentType`, `updated`)
 *   - whole-object buffered read
 *   - ranged read (single `bytes=start-end` window)
 *
 * Streaming + multi-range reads can land later when a load job actually
 * needs them. The buffered path is enough for the v0 CSV/NDJSON/Parquet
 * file sizes we expect in tests.
 */

export interface GcsObjectRef {
  readonly bucket: string;
  readonly object: string;
}

/** Parse a `gs://<bucket>/<object>` URI. Throws on a malformed URI; the
 *  caller is responsible for surfacing this as an HTTP 400. */
export function parseGcsUri(uri: string): GcsObjectRef {
  const match = uri.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (match === null) {
    throw new Error(`Not a gs:// URI: ${uri}`);
  }
  return { bucket: match[1] as string, object: match[2] as string };
}

/** The GCS API host. Reads `STORAGE_EMULATOR_HOST` lazily so tests can
 *  set it before each call without restarting the process. */
export function gcsApiHost(): string {
  const fromEnv = process.env['STORAGE_EMULATOR_HOST'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv.replace(/\/$/, '');
  return 'https://storage.googleapis.com';
}

function objectUrl(ref: GcsObjectRef, alt: 'media' | 'json'): string {
  // GCS JSON API path: /storage/v1/b/{bucket}/o/{encodedObject}
  // `alt=media` returns raw bytes; `alt=json` (the default) returns the
  // object metadata JSON. We encode the object name with
  // encodeURIComponent so slashes are preserved as %2F — required by
  // both real GCS and fake-gcs-server.
  const encoded = encodeURIComponent(ref.object);
  return `${gcsApiHost()}/storage/v1/b/${ref.bucket}/o/${encoded}?alt=${alt}`;
}

export interface GcsObjectMetadata {
  readonly size: number;
  readonly contentType: string;
  /** ISO-8601 last-modified timestamp. */
  readonly updated: string;
}

/** Fetch the metadata JSON for a single object. */
export async function getGcsObjectMetadata(uri: string): Promise<GcsObjectMetadata> {
  const ref = parseGcsUri(uri);
  const res = await fetch(objectUrl(ref, 'json'));
  if (!res.ok) {
    throw new Error(`GCS metadata fetch failed (${res.status}): ${uri}`);
  }
  const body = (await res.json()) as {
    size?: string | number;
    contentType?: string;
    updated?: string;
  };
  return {
    size: typeof body.size === 'string' ? Number(body.size) : (body.size ?? 0),
    contentType: body.contentType ?? 'application/octet-stream',
    updated: body.updated ?? '',
  };
}

export interface ReadGcsObjectOptions {
  /** Inclusive byte range. `end` omitted means "to the end of the object". */
  readonly range?: { readonly start: number; readonly end?: number };
}

/** Read an entire object (or a byte range) into memory and return the bytes. */
export async function readGcsObject(
  uri: string,
  options: ReadGcsObjectOptions = {},
): Promise<Uint8Array> {
  const ref = parseGcsUri(uri);
  const headers: Record<string, string> = {};
  if (options.range !== undefined) {
    const { start, end } = options.range;
    headers['Range'] = `bytes=${start}-${end === undefined ? '' : end}`;
  }
  const res = await fetch(objectUrl(ref, 'media'), { headers });
  if (!res.ok) {
    throw new Error(`GCS download failed (${res.status}): ${uri}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/** Read + decode an object as UTF-8 text. Convenience for CSV / NDJSON
 *  load paths that don't care about chunking. */
export async function readGcsObjectText(uri: string): Promise<string> {
  const bytes = await readGcsObject(uri);
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Upload an object to GCS via a simple media upload
 * (`POST /upload/storage/v1/b/{bucket}/o?uploadType=media&name=<object>`).
 *
 * That's the protocol both real GCS and `fake-gcs-server` accept for
 * single-shot uploads. For real GCS this would need OAuth on the
 * request — the same auth caveat as the read path applies.
 *
 * Returns the size of the uploaded body, useful for surfacing in
 * extract-job statistics.
 */
export async function writeGcsObject(
  uri: string,
  body: Uint8Array | string,
  contentType: string,
): Promise<{ readonly size: number }> {
  const ref = parseGcsUri(uri);
  const url = `${gcsApiHost()}/upload/storage/v1/b/${ref.bucket}/o?uploadType=media&name=${encodeURIComponent(ref.object)}`;
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: bytes,
  });
  if (!res.ok) {
    throw new Error(`GCS upload failed (${res.status}): ${uri}`);
  }
  return { size: bytes.byteLength };
}
