import type { DataSource } from 'typeorm';
import { TimescaleError, TimescaleErrorCode } from '@blueprime/timescaledb-core';

/**
 * Typed, read-only accessors over `timescaledb_information.*` — hypertables, chunks,
 * continuous aggregates, and background jobs / job stats — plus `runJob()` to trigger a
 * job on demand. DataSource-scoped (DB-wide, not per-entity); every filter is bound as a
 * parameter. Only long-stable catalog columns are selected so the shapes hold across the
 * supported TimescaleDB range (>= 2.18).
 */

/** Coerce a Postgres bool (JS boolean, or the `'t'`/`'true'` text forms) to a boolean. */
function toBool(v: unknown): boolean {
  return v === true || v === 't' || v === 'true';
}

/**
 * Coerce a nullable timestamp column to a `Date` (or `null`). Note: an unbounded/`infinity`
 * range bound is not a real instant, so it maps to `null` (unknown) rather than a Date.
 */
function toDateOrNull(v: unknown): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Coerce a count column (bigint may arrive as string) to a number. */
function toCount(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0);
}

/**
 * Split an optionally schema-qualified table name into `{ schema?, name }`. Splits on the
 * first dot only — `schema.name` (dotted/quoted identifier parts are not supported). Both
 * parts are matched verbatim as bound parameters.
 */
function splitQualified(table: string): { schema?: string; name: string } {
  const dot = table.indexOf('.');
  return dot === -1 ? { name: table } : { schema: table.slice(0, dot), name: table.slice(dot + 1) };
}

// ---------------------------------------------------------------------------
// Hypertables
// ---------------------------------------------------------------------------

export interface HypertableInfo {
  readonly schema: string;
  readonly name: string;
  readonly numDimensions: number;
  readonly numChunks: number;
  readonly compressionEnabled: boolean;
}

export async function listHypertables(dataSource: DataSource): Promise<HypertableInfo[]> {
  const rows: Array<Record<string, unknown>> = await dataSource.query(
    `SELECT hypertable_schema, hypertable_name, num_dimensions, num_chunks, compression_enabled
       FROM timescaledb_information.hypertables
       ORDER BY hypertable_schema, hypertable_name`,
  );
  return rows.map((r) => ({
    schema: String(r.hypertable_schema),
    name: String(r.hypertable_name),
    numDimensions: toCount(r.num_dimensions),
    numChunks: toCount(r.num_chunks),
    compressionEnabled: toBool(r.compression_enabled),
  }));
}

// ---------------------------------------------------------------------------
// Chunks
// ---------------------------------------------------------------------------

export interface ChunkInfo {
  readonly hypertableSchema: string;
  readonly hypertableName: string;
  readonly chunkSchema: string;
  readonly chunkName: string;
  /** Chunk range start/end (null for an open range or integer-time hypertables). */
  readonly rangeStart: Date | null;
  readonly rangeEnd: Date | null;
  readonly isCompressed: boolean;
}

export interface ListChunksOptions {
  /** Restrict to one hypertable (bare `name` or `schema.name`). */
  readonly hypertable?: string;
}

export async function listChunks(
  dataSource: DataSource,
  options: ListChunksOptions = {},
): Promise<ChunkInfo[]> {
  const params: unknown[] = [];
  let where = '';
  if (options.hypertable !== undefined) {
    const { schema, name } = splitQualified(options.hypertable);
    where = ` WHERE hypertable_name = $${params.push(name)}`;
    if (schema !== undefined) where += ` AND hypertable_schema = $${params.push(schema)}`;
  }
  const rows: Array<Record<string, unknown>> = await dataSource.query(
    `SELECT hypertable_schema, hypertable_name, chunk_schema, chunk_name,
            range_start, range_end, is_compressed
       FROM timescaledb_information.chunks${where}
       ORDER BY hypertable_schema, hypertable_name, range_start`,
    params,
  );
  return rows.map((r) => ({
    hypertableSchema: String(r.hypertable_schema),
    hypertableName: String(r.hypertable_name),
    chunkSchema: String(r.chunk_schema),
    chunkName: String(r.chunk_name),
    rangeStart: toDateOrNull(r.range_start),
    rangeEnd: toDateOrNull(r.range_end),
    isCompressed: toBool(r.is_compressed),
  }));
}

// ---------------------------------------------------------------------------
// Continuous aggregates
// ---------------------------------------------------------------------------

export interface ContinuousAggregateInfo {
  readonly viewSchema: string;
  readonly viewName: string;
  readonly materializedOnly: boolean;
  readonly compressionEnabled: boolean;
}

export async function listContinuousAggregates(
  dataSource: DataSource,
): Promise<ContinuousAggregateInfo[]> {
  const rows: Array<Record<string, unknown>> = await dataSource.query(
    `SELECT view_schema, view_name, materialized_only, compression_enabled
       FROM timescaledb_information.continuous_aggregates
       ORDER BY view_schema, view_name`,
  );
  return rows.map((r) => ({
    viewSchema: String(r.view_schema),
    viewName: String(r.view_name),
    materializedOnly: toBool(r.materialized_only),
    compressionEnabled: toBool(r.compression_enabled),
  }));
}

// ---------------------------------------------------------------------------
// Jobs + job stats
// ---------------------------------------------------------------------------

export interface JobInfo {
  readonly jobId: number;
  readonly applicationName: string;
  readonly scheduleInterval: string | null;
  readonly procSchema: string;
  readonly procName: string;
  readonly hypertableSchema: string | null;
  readonly hypertableName: string | null;
  readonly scheduled: boolean;
  readonly config: Record<string, unknown> | null;
}

export interface ListJobsOptions {
  /** Restrict to jobs attached to one hypertable/CAGG (bare `name` or `schema.name`). */
  readonly hypertable?: string;
}

export async function listJobs(
  dataSource: DataSource,
  options: ListJobsOptions = {},
): Promise<JobInfo[]> {
  const params: unknown[] = [];
  let where = '';
  if (options.hypertable !== undefined) {
    const { schema, name } = splitQualified(options.hypertable);
    where = ` WHERE hypertable_name = $${params.push(name)}`;
    if (schema !== undefined) where += ` AND hypertable_schema = $${params.push(schema)}`;
  }
  const rows: Array<Record<string, unknown>> = await dataSource.query(
    `SELECT job_id, application_name, schedule_interval::text AS schedule_interval,
            proc_schema, proc_name, hypertable_schema, hypertable_name, scheduled, config
       FROM timescaledb_information.jobs${where}
       ORDER BY job_id`,
    params,
  );
  return rows.map((r) => ({
    jobId: toCount(r.job_id),
    applicationName: String(r.application_name),
    scheduleInterval: r.schedule_interval == null ? null : String(r.schedule_interval),
    procSchema: String(r.proc_schema),
    procName: String(r.proc_name),
    hypertableSchema: r.hypertable_schema == null ? null : String(r.hypertable_schema),
    hypertableName: r.hypertable_name == null ? null : String(r.hypertable_name),
    scheduled: toBool(r.scheduled),
    config: (r.config as Record<string, unknown> | null) ?? null,
  }));
}

export interface JobStats {
  readonly jobId: number;
  readonly hypertableSchema: string | null;
  readonly hypertableName: string | null;
  readonly lastRunStartedAt: Date | null;
  readonly lastSuccessfulFinish: Date | null;
  readonly lastRunStatus: string | null;
  readonly jobStatus: string | null;
  readonly totalRuns: number;
  readonly totalSuccesses: number;
  readonly totalFailures: number;
  readonly nextStart: Date | null;
}

/** Read one job's execution stats, or `null` if the job id is unknown. */
export async function getJobStats(dataSource: DataSource, jobId: number): Promise<JobStats | null> {
  assertJobId(jobId);
  const rows: Array<Record<string, unknown>> = await dataSource.query(
    `SELECT job_id, hypertable_schema, hypertable_name, last_run_started_at,
            last_successful_finish, last_run_status, job_status,
            total_runs, total_successes, total_failures, next_start
       FROM timescaledb_information.job_stats WHERE job_id = $1`,
    [jobId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    jobId: toCount(r.job_id),
    hypertableSchema: r.hypertable_schema == null ? null : String(r.hypertable_schema),
    hypertableName: r.hypertable_name == null ? null : String(r.hypertable_name),
    lastRunStartedAt: toDateOrNull(r.last_run_started_at),
    lastSuccessfulFinish: toDateOrNull(r.last_successful_finish),
    lastRunStatus: r.last_run_status == null ? null : String(r.last_run_status),
    jobStatus: r.job_status == null ? null : String(r.job_status),
    totalRuns: toCount(r.total_runs),
    totalSuccesses: toCount(r.total_successes),
    totalFailures: toCount(r.total_failures),
    nextStart: toDateOrNull(r.next_start),
  };
}

/** Validate a job id is a positive integer before it reaches SQL. */
function assertJobId(jobId: number): void {
  if (!Number.isSafeInteger(jobId) || jobId <= 0) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `jobId must be a positive integer, got ${JSON.stringify(jobId)}`,
      { jobId },
    );
  }
}

/**
 * Run a background job now via `run_job(<id>)`. Executes standalone (autocommit) since a
 * job's action (e.g. a continuous-aggregate refresh) may not run inside a transaction.
 */
export async function runJob(dataSource: DataSource, jobId: number): Promise<void> {
  assertJobId(jobId);
  await dataSource.query('CALL run_job($1)', [jobId]);
}
