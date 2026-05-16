/**
 * Pure routing logic — no I/O.
 *
 * `compileRoute` turns a `RouteDefinition` (with `{name}` placeholders) into a
 * `CompiledRoute` (regex + parameter names). `matchRoute` walks a list of
 * compiled routes and returns the first method+path match together with the
 * extracted parameters.
 */

import type { Handler, RouteDefinition } from './types.ts';

export interface CompiledRoute {
  readonly method: string;
  readonly regex: RegExp;
  readonly paramNames: readonly string[];
  readonly handler: Handler;
}

export interface RouteMatch {
  readonly route: CompiledRoute;
  readonly params: Readonly<Record<string, string>>;
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

function escapeRegex(literal: string): string {
  return literal.replace(REGEX_META, '\\$&');
}

export function compileRoute(def: RouteDefinition): CompiledRoute {
  const paramNames: string[] = [];
  const parts = def.path.split(/(\{[^}]+\})/);
  const pattern = parts
    .map((part) => {
      if (part.length >= 2 && part.startsWith('{') && part.endsWith('}')) {
        paramNames.push(part.slice(1, -1));
        return '([^/]+)';
      }
      return escapeRegex(part);
    })
    .join('');
  return {
    method: def.method.toUpperCase(),
    regex: new RegExp(`^${pattern}$`),
    paramNames,
    handler: def.handler,
  };
}

export function compileRoutes(defs: readonly RouteDefinition[]): CompiledRoute[] {
  return defs.map(compileRoute);
}

export function matchRoute(
  routes: readonly CompiledRoute[],
  method: string,
  pathname: string,
): RouteMatch | null {
  const upper = method.toUpperCase();
  for (const route of routes) {
    if (route.method !== upper) continue;
    const captures = route.regex.exec(pathname);
    if (captures === null) continue;
    const params: Record<string, string> = {};
    for (let i = 0; i < route.paramNames.length; i++) {
      const name = route.paramNames[i];
      const value = captures[i + 1];
      // Unreachable in practice: compileRoute generates one capture group per
      // name, and `[^/]+` cannot produce an undefined capture.
      if (name === undefined || value === undefined) continue;
      params[name] = decodeURIComponent(value);
    }
    return { route, params };
  }
  return null;
}

export function parseQueryString(search: string): Record<string, string> {
  const out: Record<string, string> = {};
  const trimmed = search.startsWith('?') ? search.slice(1) : search;
  if (trimmed === '') return out;
  const sp = new URLSearchParams(trimmed);
  for (const [key, value] of sp) {
    out[key] = value;
  }
  return out;
}
