/**
 * Ambient types for `csv-batch` (ships JS only; no upstream types).
 *
 * We use the simplest invocation shape: stream in, fully-buffered result
 * out. Batching and the custom-reducer modes are unused — the load job
 * fits the whole CSV in memory before inserting (BigQuery's load jobs
 * cap at 5 TB, far past anything we'd plausibly test against).
 */
declare module 'csv-batch' {
  export interface CsvBatchOptions {
    readonly header?: boolean;
    readonly columns?: readonly string[];
    readonly delimiter?: string;
    readonly quote?: string;
    readonly detail?: boolean;
    readonly nullOnEmpty?: boolean;
  }

  export interface CsvBatchResult<R = Record<string, string>> {
    readonly totalRecords: number;
    readonly data: readonly R[];
  }

  /** Parses a Node Readable stream as CSV and resolves with all rows. */
  function csvBatch<R = Record<string, string>>(
    stream: NodeJS.ReadableStream,
    options?: CsvBatchOptions,
  ): Promise<CsvBatchResult<R>>;

  export default csvBatch;
}
