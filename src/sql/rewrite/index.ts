import { arrayHandlers } from './array.ts';
import type { CallHandler } from './context.ts';
import { datetimeHandlers } from './datetime.ts';
import { geoHandlers } from './geo.ts';
import { jsonHandlers } from './json.ts';
import { mathHandlers } from './math.ts';
import { stringHandlers } from './string.ts';

/** Function-name (uppercase) → rewrite handler. Consulted by handleIdentifier
 * once it knows the identifier is a function call (`name(`). */
export const CALL_HANDLERS: ReadonlyMap<string, CallHandler> = new Map([
  ...datetimeHandlers,
  ...stringHandlers,
  ...jsonHandlers,
  ...arrayHandlers,
  ...mathHandlers,
  ...geoHandlers,
]);

export type { RewriteCtx, CallHandler } from './context.ts';
