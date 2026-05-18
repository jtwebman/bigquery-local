/**
 * Test/dev helpers for talking to a bigquery-local emulator from the
 * official `@google-cloud/bigquery` client (and any other consumer of
 * `google-auth-library`).
 *
 * The official BQ client uses `google-auth-library` to obtain OAuth tokens
 * by default. With `apiEndpoint` set to the emulator the URL is right but
 * the client still tries to authenticate against Google — which fails
 * unless real credentials are available. `emulatorGoogleAuth()` returns
 * a `GoogleAuth` instance that short-circuits the token flow with a
 * fixed placeholder, so the client talks to the emulator without ever
 * calling Google.
 *
 * Usage:
 *
 *     import { BigQuery } from '@google-cloud/bigquery';
 *     import { emulatorGoogleAuth } from 'bigquery-local';
 *
 *     const bq = new BigQuery({
 *       projectId: 'my-project',
 *       apiEndpoint: 'http://localhost:9050',
 *       authClient: emulatorGoogleAuth(),
 *     });
 *
 * The emulator also accepts the URL form `${apiEndpoint}/bigquery/v2/...`
 * that the client uses by default, so no extra routing setup is needed.
 */

import { type AnyAuthClient, OAuth2Client } from 'google-auth-library';

/** A minimal `OAuth2Client` subclass that returns a fixed placeholder token
 *  without ever calling Google. The emulator ignores the token; the only
 *  reason it's set is so the client library doesn't error before sending
 *  the request.
 *
 *  Why `OAuth2Client` and not `GoogleAuth`? The @google-cloud/bigquery
 *  typings declare `authClient: AnyAuthClient | undefined` — the union of
 *  concrete auth-client subclasses, not `GoogleAuth`. By extending
 *  `OAuth2Client` we satisfy that contract; at runtime the
 *  @google-cloud/common request pipeline wraps any non-GoogleAuth
 *  `authClient` in its own GoogleAuth, then calls our methods through
 *  that wrapper.
 *
 *  Return types are intentionally loose: `google-auth-library` is heavily
 *  generic across `Headers` / `GaxiosOptions` shapes and the exact
 *  signatures shift between versions. The runtime contract is stable. */
// biome-ignore lint/suspicious/noExplicitAny: return types vary across versions.
type LooseAuth = any;

export class EmulatorAuthClient extends OAuth2Client {
  /** Headers attached to every outgoing request. */
  override getRequestHeaders(): Promise<LooseAuth> {
    return Promise.resolve(new Headers({ Authorization: 'Bearer emulator' }));
  }

  /** Some callers reach for the raw access token. */
  // biome-ignore lint/suspicious/noExplicitAny: see LooseAuth comment.
  override getAccessToken(): Promise<any> {
    return Promise.resolve({ token: 'emulator' });
  }
}

/** Convenience factory — most callers don't need to subclass. */
export function emulatorGoogleAuth(): AnyAuthClient {
  return new EmulatorAuthClient() as unknown as AnyAuthClient;
}
