import type { Token } from '../tokenize.ts';

/**
 * Everything a function-call rewrite handler needs. `tr` is translateRange
 * bound to the active paramOrder/project, so handlers and combinators never
 * import translate.ts directly (which would cycle).
 */
export interface RewriteCtx {
  readonly tokens: readonly Token[];
  /** Index of the function-name identifier token. */
  readonly i: number;
  /** Index of the opening `(`. */
  readonly parenIdx: number;
  readonly endIdx: number;
  readonly out: string[];
  /** Raw function token text — for error messages and pass-through. */
  readonly funcName: string;
  /** Translate a token sub-range `[start, end)` with the active params/project. */
  readonly tr: (start: number, end: number) => string;
}

/** A function-call rewrite: emits onto `ctx.out` and returns the resume index. */
export type CallHandler = (ctx: RewriteCtx) => number;
