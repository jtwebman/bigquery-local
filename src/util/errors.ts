/**
 * Google-shaped BigQuery API error.
 *
 * Wire format (returned in every error response body):
 *
 *     { "error": {
 *         "code": <http-status>,
 *         "errors": [{ "reason": <reason>, "message": <msg>, "location"?: <field> }],
 *         "message": <msg>
 *     } }
 *
 * Each `reason` deterministically maps to an HTTP status (also placed in
 * `error.code`). Throw a `BqError` from any route handler — the server
 * catches it and emits the matching response.
 */

export type BqErrorReason =
  | 'notFound'
  | 'duplicate'
  | 'invalid'
  | 'accessDenied'
  | 'internalError'
  | 'quotaExceeded'
  | 'unsupportedFeature'
  | 'conditionNotMet';

const REASON_TO_STATUS: Record<BqErrorReason, number> = {
  notFound: 404,
  duplicate: 409,
  invalid: 400,
  accessDenied: 403,
  internalError: 500,
  quotaExceeded: 429,
  unsupportedFeature: 400,
  conditionNotMet: 412,
};

export interface BqErrorEntry {
  readonly reason: BqErrorReason;
  readonly message: string;
  readonly location?: string;
}

export interface BqErrorBody {
  readonly error: {
    readonly code: number;
    readonly errors: readonly BqErrorEntry[];
    readonly message: string;
  };
}

export class BqError extends Error {
  public readonly reason: BqErrorReason;
  public readonly code: number;
  public readonly location: string | undefined;

  constructor(reason: BqErrorReason, message: string, location?: string) {
    super(message);
    this.name = 'BqError';
    this.reason = reason;
    this.code = REASON_TO_STATUS[reason];
    this.location = location;
  }

  toResponseBody(): BqErrorBody {
    const entry: BqErrorEntry =
      this.location === undefined
        ? { reason: this.reason, message: this.message }
        : { reason: this.reason, message: this.message, location: this.location };
    return {
      error: {
        code: this.code,
        errors: [entry],
        message: this.message,
      },
    };
  }

  static notFound(message: string, location?: string): BqError {
    return new BqError('notFound', message, location);
  }

  static duplicate(message: string, location?: string): BqError {
    return new BqError('duplicate', message, location);
  }

  static invalid(message: string, location?: string): BqError {
    return new BqError('invalid', message, location);
  }

  static accessDenied(message: string, location?: string): BqError {
    return new BqError('accessDenied', message, location);
  }

  static internalError(message: string, location?: string): BqError {
    return new BqError('internalError', message, location);
  }

  static quotaExceeded(message: string, location?: string): BqError {
    return new BqError('quotaExceeded', message, location);
  }

  static unsupportedFeature(message: string, location?: string): BqError {
    return new BqError('unsupportedFeature', message, location);
  }

  static conditionNotMet(message: string, location?: string): BqError {
    return new BqError('conditionNotMet', message, location);
  }
}
