/**
 * The normalization layer for the migration engine (M4.0). Postgres renders the same logical value
 * in many text forms and fills defaults silently, so comparing a decorator's desired-state against
 * live introspection on raw values produces false-positive diffs. Every function here reduces a
 * value to a canonical form so that two states that are *semantically equal to the database* compare
 * equal. Pure and DB-free (safe in `@blueprime/timescaledb-core`).
 *
 * Grounded in the M4 research (`.plans/research/2026-07-21-migration-engine/`, H1): recoverability
 * is high, but the real work is suppressing representation drift — intervals, defaults, policy-config
 * shapes, and CAGG definition text.
 *
 * ⚠️ **IntervalStyle precondition.** The interval parser understands only Postgres's default
 * `IntervalStyle = 'postgres'` output (e.g. `1 day 02:00:00`, `-1 days +02:00:00`). Under
 * `sql_standard` (`1 2:00:00`) or `iso_8601` (`P1DT2H`) the forms differ and would mis-canonicalize;
 * an unrecognized form is quarantined to a `raw:` key rather than confidently mis-parsed. The
 * Slice-2 introspection reader MUST `SET LOCAL intervalstyle = 'postgres'` before reading intervals.
 */

import type { ContinuousAggregateState, IntervalOrInt, PolicyState } from './schema-state.js';
import { TimescaleError, TimescaleErrorCode } from './errors.js';

const USECS_PER_DAY = 86_400_000_000n;
// Postgres `interval_cmp_value` (which `interval_eq` / the `=` operator uses) canonicalizes with a
// 30-day month and a 24-hour day — NOT the `EXTRACT(epoch)` convention. So `1 mon` = `30 days`,
// `1 year` (=12 mon) = `360 days`, `1 day` = `24 hours`, but `1 mon` != `31 days`. Verified against
// real Postgres 17. Matching this exact rule is what makes the diff agree with what the database
// itself treats as equal.
const USECS_PER_MONTH = 30n * USECS_PER_DAY;

const UNIT_MICROS: Record<string, bigint> = {
  microsecond: 1n,
  millisecond: 1_000n,
  second: 1_000_000n,
  sec: 1_000_000n,
  minute: 60_000_000n,
  min: 60_000_000n,
  hour: 3_600_000_000n,
};
// day/week feed the "days" accumulator; month/mon/year feed "months" — kept separate because a
// month is not a fixed micro count (the 30-day rule is applied only at final canonicalization).
const UNIT_DAYS: Record<string, number> = { day: 1, week: 7 };
const UNIT_MONTHS: Record<string, number> = { mon: 1, month: 1, year: 12 };

// Both regexes are FULLY ANCHORED and applied to a SINGLE whitespace-split token, never scanned
// globally over the whole string — so neither can backtrack super-linearly (no polynomial ReDoS,
// even on a token of many `9`s). Sign accepts `+`/`-` (Postgres emits mixed-sign `-1 days +02:00:00`);
// hours may exceed two digits (`100:00:00`); minutes/seconds are zero-padded two-digit fields.
const NUM_TOKEN_RE = /^-?\d+$/;
const TIME_TOKEN_RE = /^([+-]?)(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/;

/** Strip a trailing plural `s` and lowercase, so `days`→`day`, `Mons`→`mon`. */
function singular(unit: string): string {
  const u = unit.toLowerCase();
  return u.endsWith('s') ? u.slice(0, -1) : u;
}

/**
 * Canonicalize an interval-or-integer to a stable comparison KEY. Integer intervals (integer-time
 * hypertables) return `int:<n>`; interval strings return `us:<total-microseconds>` computed with
 * Postgres's 30-day-month / 24-hour-day comparison rule. An unrecognized string — OR one that
 * carries unrecognized tokens beyond the parts we matched — returns `raw:<collapsed-lowercase-text>`:
 * a fail-safe that still compares equal to itself and unequal to a genuinely different value, rather
 * than confidently mis-canonicalizing (or throwing and wedging a whole diff). See the IntervalStyle
 * precondition in the module header.
 */
export function canonicalizeInterval(value: IntervalOrInt): string {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) return `raw:${String(value)}`;
    return `int:${value}`;
  }
  if (typeof value !== 'string') return `raw:${String(value)}`;
  const text = value.trim();
  const raw = (): string => `raw:${text.toLowerCase().replace(/\s+/g, ' ')}`;

  // Tokenize on whitespace (linear) and recognize either a standalone `HH:MM:SS` time token or a
  // `<number> <unit>` pair. ANY unrecognized token quarantines the whole value to `raw:` rather than
  // risk a confident partial mis-parse (e.g. a non-`postgres` IntervalStyle, or junk like
  // "every 5 minutes"). Applying the anchored regexes per-token avoids the polynomial backtracking a
  // global scan would allow.
  const parts = text.split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) return raw();

  let months = 0n;
  let days = 0n;
  let micros = 0n;

  for (let i = 0; i < parts.length; ) {
    const tok = parts[i]!;
    const tm = TIME_TOKEN_RE.exec(tok);
    if (tm) {
      const sign = tm[1] === '-' ? -1n : 1n;
      // Round sub-microsecond fractional seconds to µs (Postgres rounds, e.g. `.9999999`s → 1s); the
      // carry is handled naturally because fracMicros is added straight into the total.
      let fracMicros = 0n;
      if (tm[5]) {
        const padded = (tm[5] + '0000000').slice(0, 7); // 6 µs digits + 1 rounding digit
        fracMicros = BigInt(padded.slice(0, 6)) + (Number(padded[6]) >= 5 ? 1n : 0n);
      }
      micros +=
        sign *
        (BigInt(tm[2]!) * 3_600_000_000n +
          BigInt(tm[3]!) * 60_000_000n +
          BigInt(tm[4]!) * 1_000_000n +
          fracMicros);
      i += 1;
      continue;
    }
    // Otherwise expect a `<number> <unit>` pair.
    const unitTok = parts[i + 1];
    if (!NUM_TOKEN_RE.test(tok) || unitTok === undefined) return raw();
    const n = BigInt(tok);
    const unit = singular(unitTok.toLowerCase());
    if (unit in UNIT_MICROS) micros += n * UNIT_MICROS[unit]!;
    else if (unit in UNIT_DAYS) days += n * BigInt(UNIT_DAYS[unit]!);
    else if (unit in UNIT_MONTHS) months += n * BigInt(UNIT_MONTHS[unit]!);
    else return raw(); // unrecognized unit word
    i += 2;
  }

  const total = months * USECS_PER_MONTH + days * USECS_PER_DAY + micros;
  return `us:${total.toString()}`;
}

/** Two intervals are equal iff their canonical keys match (Postgres `=` semantics). */
export function intervalsEqual(
  a: IntervalOrInt | undefined,
  b: IntervalOrInt | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return canonicalizeInterval(a) === canonicalizeInterval(b);
}

/**
 * Assert a string is an interval this engine can parse — accepting ANY Postgres `intervalstyle=postgres`
 * OUTPUT form: `<n> <unit>`, the `HH:MM:SS[.ffffff]` time form, a compound form (`1 day 02:00:00`), and
 * mixed-sign. Use this for interval values that ORIGINATE from catalog introspection (the current-state
 * `from` of an alter), where the strict `<n> <unit>` `INTERVAL_PATTERN` (`interval.ts`) is too narrow and
 * would reject a legitimate sub-day/compound interval — while `quoteLiteral` still makes the emitted
 * literal injection-safe. Validates via {@link canonicalizeInterval} (ReDoS-safe): an unrecognized value
 * canonicalizes to `raw:` and is rejected. With `positive`, also rejects a zero/negative interval.
 */
export function assertParsableInterval(
  value: string,
  role = 'interval',
  options?: { readonly positive?: boolean },
): string {
  if (typeof value !== 'string') {
    throw new TimescaleError(TimescaleErrorCode.INVALID_ARGUMENT, `${role} must be a string`, {
      role,
    });
  }
  const key = canonicalizeInterval(value);
  if (key.startsWith('raw:')) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `${role} is not a recognized Postgres interval (intervalstyle=postgres): ${value}`,
      { role, value },
    );
  }
  if (options?.positive) {
    // key is `us:<micros>` or `int:<n>`; both carry the magnitude after the colon.
    const magnitude = BigInt(key.slice(key.indexOf(':') + 1));
    if (magnitude <= 0n) {
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        `${role} must be a positive interval, got: ${value}`,
        { role, value },
      );
    }
  }
  return value;
}

/**
 * Map a TimescaleDB background-job `proc_name` + its `config` JSON to a logical {@link PolicyState}.
 * The config key that names the threshold differs per policy (`compress_after`/`compress_created_before`
 * / `drop_after`/`drop_created_before` / `start_offset`+`end_offset`), and internal ids
 * (`hypertable_id`, `mat_hypertable_id`) are stripped — they are per-database sequence values, never
 * part of desired state. An unrecognized `proc_name` (a user `add_job`) degrades to `unmanaged`
 * carrying the raw config, surfaced but never edited.
 */
export function parsePolicyConfig(
  procName: string,
  config: Readonly<Record<string, unknown>>,
  scheduleInterval?: IntervalOrInt,
): PolicyState {
  const iv = (v: unknown): IntervalOrInt | undefined =>
    typeof v === 'string' || typeof v === 'number' ? v : undefined;
  // `exactOptionalPropertyTypes` forbids setting an optional field to an explicit `undefined`, so
  // each field is spread in only when present (an absent key, not a `undefined` value).
  const opt = (key: string, v: IntervalOrInt | undefined): Record<string, IntervalOrInt> =>
    v !== undefined ? { [key]: v } : {};
  const sched = opt('scheduleInterval', scheduleInterval);
  switch (procName) {
    case 'policy_compression':
      return {
        kind: 'compression',
        ...opt('after', iv(config['compress_after'])),
        ...opt('createdBefore', iv(config['compress_created_before'])),
        ...sched,
      };
    case 'policy_retention':
      return {
        kind: 'retention',
        ...opt('after', iv(config['drop_after'])),
        ...opt('createdBefore', iv(config['drop_created_before'])),
        ...sched,
      };
    case 'policy_refresh_continuous_aggregate':
      return {
        kind: 'refresh',
        ...opt('startOffset', iv(config['start_offset'])),
        ...opt('endOffset', iv(config['end_offset'])),
        ...sched,
      };
    default: {
      // Strip internal ids from the surfaced raw config, but keep everything else opaque.
      const raw: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(config)) {
        if (k !== 'hypertable_id' && k !== 'mat_hypertable_id') raw[k] = v;
      }
      return { kind: 'unmanaged', procName, rawConfig: Object.freeze(raw), ...sched };
    }
  }
}

/** Two policies are equal iff their kind + canonicalized thresholds/offsets + schedule all match.
 * Narrows per kind so only the fields that exist on that kind participate. */
export function policiesEqual(a: PolicyState | undefined, b: PolicyState | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'unmanaged' && b.kind === 'unmanaged') {
    return (
      a.procName === b.procName &&
      JSON.stringify(a.rawConfig ?? {}) === JSON.stringify(b.rawConfig ?? {}) &&
      intervalsEqual(a.scheduleInterval, b.scheduleInterval)
    );
  }
  if (a.kind === 'refresh' && b.kind === 'refresh') {
    return (
      intervalsEqual(a.startOffset, b.startOffset) &&
      intervalsEqual(a.endOffset, b.endOffset) &&
      intervalsEqual(a.scheduleInterval, b.scheduleInterval)
    );
  }
  if (
    (a.kind === 'compression' || a.kind === 'retention') &&
    (b.kind === 'compression' || b.kind === 'retention')
  ) {
    return (
      intervalsEqual(a.after, b.after) &&
      intervalsEqual(a.createdBefore, b.createdBefore) &&
      intervalsEqual(a.scheduleInterval, b.scheduleInterval)
    );
  }
  return false;
}

/**
 * Normalize a continuous-aggregate SELECT definition for comparison. The reader should source this
 * from `timescaledb_information.continuous_aggregates.view_definition` (Postgres's own planner-
 * normalized form — aliases re-expanded, implicit casts materialized, keywords lower-cased), NOT the
 * raw DDL text or `pg_views` (which exposes the UNION-ALL + `cagg_watermark()` materialization
 * internals). This only collapses whitespace and strips a trailing semicolon — it deliberately does
 * **NOT** lowercase, because that would corrupt case-sensitive string literals (`'Active'`) and
 * quoted identifiers (`"CamelCol"`), masking or fabricating a real CAGG change. (Full parse-tree
 * equality needs the DB; this is the DB-free textual reduction of an already-normalized definition.)
 */
export function normalizeCaggDefinition(definition: string): string {
  const collapsed = definition.replace(/\s+/g, ' ').trim();
  // Strip a single trailing semicolon WITHOUT a `\s*…\s*$` regex — that form backtracks
  // quadratically on all-whitespace input (CodeQL js/polynomial-redos). Whitespace is already
  // collapsed + trimmed above, so `endsWith`/`slice` is a linear, equivalent strip.
  return collapsed.endsWith(';') ? collapsed.slice(0, -1).trimEnd() : collapsed;
}

/** Two CAGG definitions are equal iff their normalized forms match. */
export function caggDefinitionsEqual(a: string, b: string): boolean {
  return normalizeCaggDefinition(a) === normalizeCaggDefinition(b);
}

/**
 * TimescaleDB/Postgres defaults that are filled silently, so an unset decorator value must NOT diff
 * against the system-filled value the catalog reports. Consulted by the diff engine (M4.2) when the
 * desired side left a knob unset. Values are intentionally the documented defaults for the supported
 * versions; version-specific overrides are layered by the reader when they differ.
 */
export const TIMESCALE_DEFAULTS = {
  /** `create_hypertable` default chunk interval when none is given. */
  chunkInterval: '7 days',
  /** `add_*_policy` default `schedule_interval` (documented as the policy's own cadence). */
  policyScheduleInterval: undefined as IntervalOrInt | undefined,
  /** When `compress_orderby` is omitted, TimescaleDB defaults it to the (first) time/bucket column
   * DESC — the reader resolves the concrete column; this flags that a default was applied. */
  columnstoreOrderByDefaultsToTimeColumn: true,
} as const;

/** Convenience: the comparable surface of a CAGG (definition + flags + source). */
export function caggComparable(c: ContinuousAggregateState): {
  definition: string;
  materializedOnly: boolean;
  hierarchical: boolean;
  source: string;
} {
  return {
    definition: normalizeCaggDefinition(c.definition),
    materializedOnly: c.materializedOnly,
    hierarchical: c.hierarchical,
    source: c.source,
  };
}
