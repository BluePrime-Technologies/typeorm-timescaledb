/**
 * Extract the facets that actually define a continuous aggregate from a rendered SELECT.
 *
 * ## Why this exists rather than comparing text
 *
 * `check` currently answers "I did not look" for every continuous aggregate: `diffContinuousAggregates`
 * compares presence only and raises a `not-compared` advisory. Comparing the definitions AS TEXT is
 * not a cheaper alternative — it is a broken one. Measured on PostgreSQL 17 / TimescaleDB 2.29.1,
 * declaring exactly what this library emits and reading `view_definition` straight back:
 *
 * ```sql
 * -- declared
 * SELECT time_bucket(INTERVAL '1 hour', "time") AS "bucket", "sensor_id", avg(value) AS "avg_value"
 *   FROM sensor_reading GROUP BY 1, 2
 *
 * -- returned
 *  SELECT time_bucket('01:00:00'::interval, "time") AS bucket,
 *     sensor_id,
 *     avg(value) AS avg_value
 *    FROM sensor_reading
 *   GROUP BY (time_bucket('01:00:00'::interval, "time")), sensor_id;
 * ```
 *
 * Five independent divergences on the simplest possible aggregate: the interval literal is
 * reformatted and its cast syntax changed, unnecessary identifier quoting is stripped, the layout is
 * reindented, a terminator is appended, and `GROUP BY 1, 2` is EXPANDED into the full expressions.
 *
 * That last one settles it. To normalize `GROUP BY 1` into
 * `GROUP BY (time_bucket('01:00:00'::interval, "time"))`, a text comparator must resolve positional
 * references against the SELECT list — it must parse the SELECT. At which point it has facets, and
 * text comparison has become facet comparison with extra steps and a worse failure mode.
 *
 * ## The contract that matters
 *
 * `undefined` is a FIRST-CLASS RESULT, not an error. It means "this shape is not one I can read",
 * and the caller must fall back to today's `not-compared` advisory. That is what keeps this
 * strictly additive: an aggregate this parser cannot read is no worse off than it is today, and one
 * it can read gains a real answer. The failure mode to avoid at all costs is inventing a facet from
 * a shape we half-understood and reporting drift on a converged database — a gate that fires
 * spuriously gets switched off, which is worse than a gate that admits it did not look.
 *
 * So every branch here bails to `undefined` rather than guessing.
 */

import { canonicalizeInterval } from './normalize.js';

/** One aggregate output column, e.g. `avg(value) AS avg_value`. */
export interface CaggAggregateFacet {
  /** Lower-cased function name, e.g. `avg`. */
  readonly fn: string;
  /** The aggregated column, or `undefined` for `count(*)`. */
  readonly column?: string;
  /** Output alias. */
  readonly as: string;
}

/** The facets that define a continuous aggregate, independent of how the server renders them. */
export interface CaggFacets {
  /**
   * Bucket width CANONICALISED via {@link canonicalizeInterval} (`us:3600000000`), never the raw
   * text. The declared form (`INTERVAL '1 hour'`) and the stored form (`'01:00:00'::interval`) are
   * the same width rendered two ways — comparing the strings would report drift on an aggregate
   * nobody changed, which is the exact failure this module exists to avoid.
   */
  readonly bucketWidth: string;
  /** The time column the bucket is computed over, unquoted. */
  readonly timeColumn: string;
  /** Source relation, unquoted. */
  readonly source: string;
  /** GROUP BY keys BESIDES the time bucket, as an unordered set. */
  readonly groupBy: readonly string[];
  /** Aggregate output columns, ordered by alias so ordering is not spurious drift. */
  readonly aggregates: readonly CaggAggregateFacet[];
}

/** Strip one layer of double quotes from an identifier, if present. */
function unquote(raw: string): string {
  const t = raw.trim();
  return t.startsWith('"') && t.endsWith('"') && t.length >= 2
    ? t.slice(1, -1).replace(/""/g, '"')
    : t;
}

/**
 * Split a SELECT list on top-level commas — never inside parentheses or a quoted span.
 * `avg(value), time_bucket('1 h', "t")` is two items, not four.
 */
function splitTopLevel(text: string): string[] | undefined {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === quote) {
        if (text[i + 1] === quote) i++;
        else quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) return undefined; // unbalanced — refuse rather than guess
    } else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0 || quote !== null) return undefined;
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** `time_bucket('01:00:00'::interval, "time")` -> width + column. Also accepts `INTERVAL '1 hour'`. */
const BUCKET_RE =
  /^time_bucket\(\s*(?:'([^']*)'::interval|INTERVAL\s+'([^']*)')\s*,\s*("(?:[^"]|"")+"|[A-Za-z_][\w$]*)\s*\)$/i;

/** `avg(value) AS avg_value`, `count(*) AS n`. Deliberately does NOT accept nested expressions. */
const AGG_RE =
  /^([A-Za-z_][\w$]*)\(\s*(\*|"(?:[^"]|"")+"|[A-Za-z_][\w$]*)\s*\)\s+AS\s+("(?:[^"]|"")+"|[A-Za-z_][\w$]*)$/i;

/**
 * Parse a rendered continuous-aggregate SELECT into its facets.
 *
 * Returns `undefined` for ANY shape it does not fully understand — a join, a WHERE clause, a
 * nested expression, a HAVING, a window function, an unbalanced string. The caller reports
 * `not-compared` for those, exactly as it does today.
 */
export function extractCaggFacets(definition: string): CaggFacets | undefined {
  // Normalize whitespace and drop the terminator the server appends.
  const sql = definition.replace(/\s+/g, ' ').trim().replace(/;$/, '').trim();

  // Anything beyond SELECT/FROM/GROUP BY is a shape this parser does not claim to read. Bailing
  // here is what keeps a WHERE-filtered or joined aggregate honest rather than silently mis-read.
  if (/\b(JOIN|WHERE|HAVING|UNION|WINDOW|DISTINCT|ORDER\s+BY|LIMIT)\b/i.test(sql)) return undefined;

  const m = /^SELECT\s+(.+?)\s+FROM\s+(.+?)\s+GROUP\s+BY\s+(.+)$/i.exec(sql);
  if (m === null) return undefined;

  const [, selectList, fromPart, groupPart] = m;
  if (selectList === undefined || fromPart === undefined || groupPart === undefined)
    return undefined;

  // A single relation only — a comma here is an implicit join.
  if (/[,()]/.test(fromPart)) return undefined;
  const source = unquote(fromPart);

  const items = splitTopLevel(selectList);
  if (items === undefined || items.length < 2) return undefined;

  // The first item must be the time bucket; that is the shape this library emits, and an aggregate
  // whose bucket is elsewhere is one we do not claim to understand.
  const first = items[0];
  if (first === undefined) return undefined;
  const bucketMatch = /^(.*?)\s+AS\s+("(?:[^"]|"")+"|[A-Za-z_][\w$]*)$/i.exec(first);
  const bucketExpr = bucketMatch?.[1]?.trim() ?? first;
  const bm = BUCKET_RE.exec(bucketExpr);
  if (bm === null) return undefined;
  const bucketWidth = (bm[1] ?? bm[2] ?? '').trim();
  const timeColumnRaw = bm[3];
  if (bucketWidth.length === 0 || timeColumnRaw === undefined) return undefined;

  const groupBy: string[] = [];
  const aggregates: CaggAggregateFacet[] = [];

  for (const item of items.slice(1)) {
    const agg = AGG_RE.exec(item);
    if (agg !== null) {
      const [, fn, arg, alias] = agg;
      if (fn === undefined || arg === undefined || alias === undefined) return undefined;
      aggregates.push({
        fn: fn.toLowerCase(),
        ...(arg === '*' ? {} : { column: unquote(arg) }),
        as: unquote(alias),
      });
      continue;
    }
    // Not an aggregate — must be a plain grouped column, optionally aliased.
    const plain =
      /^("(?:[^"]|"")+"|[A-Za-z_][\w$]*)(?:\s+AS\s+("(?:[^"]|"")+"|[A-Za-z_][\w$]*))?$/i.exec(item);
    if (plain === null || plain[1] === undefined) return undefined;
    groupBy.push(unquote(plain[1]));
  }

  if (aggregates.length === 0) return undefined;

  // Cross-check the GROUP BY clause against the grouped columns we inferred from the SELECT list.
  // The server expands positional refs, so the bucket appears here as its full expression; every
  // OTHER key must be one of the plain columns above. A key we cannot account for means the parse
  // is incomplete, so refuse.
  const groupItems = splitTopLevel(groupPart);
  if (groupItems === undefined) return undefined;
  const accountedFor = new Set(groupBy);
  for (const key of groupItems) {
    const bare = key.replace(/^\((.*)\)$/s, '$1').trim();
    if (BUCKET_RE.test(bare)) continue; // the bucket itself
    if (/^\d+$/.test(bare)) continue; // an unexpanded positional reference
    if (accountedFor.has(unquote(bare))) continue;
    return undefined;
  }

  return {
    bucketWidth: canonicalizeInterval(bucketWidth),
    timeColumn: unquote(timeColumnRaw),
    source,
    groupBy: [...groupBy].sort(),
    aggregates: [...aggregates].sort((a, b) => a.as.localeCompare(b.as)),
  };
}

/** True when two aggregates are structurally the same. Order-insensitive by construction. */
export function caggFacetsEqual(a: CaggFacets, b: CaggFacets): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
