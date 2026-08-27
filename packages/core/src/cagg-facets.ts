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

/** Calendar units, whose length is variable and therefore NOT convertible to a fixed µs count. */
const CALENDAR_UNIT_RE = /^(mon|mons|month|months|y|yr|yrs|year|years)$/i;
const YEAR_UNIT_RE = /^(y|yr|yrs|year|years)$/i;

/**
 * Canonicalise a BUCKET WIDTH, keeping calendar months separate from fixed durations.
 *
 * `canonicalizeInterval` deliberately collapses everything into one µs scalar using Postgres's
 * `interval_cmp` rule, where a month is exactly 30 days (`normalize.ts`: `USECS_PER_MONTH = 30n *
 * USECS_PER_DAY`). That is CORRECT for the thing it was written for — comparing policy thresholds,
 * where Postgres itself does the same — and WRONG for a bucket width. Verified by execution:
 * `1 mon` and `30 days` both yield `us:2592000000000`, and `1 year` and `360 days` both yield
 * `us:31104000000000`.
 *
 * A TimescaleDB month bucket is calendar-variable: it starts on the 1st and runs 28–31 days. It is
 * simply not the same aggregate as a fixed 30-day bucket, so collapsing them would report "no drift"
 * across a change that silently re-buckets every row — the widening an hourly aggregate to monthly
 * is one of the most common real edits a user makes.
 *
 * So months are carried as their own dimension. Widths with no calendar unit keep the existing
 * single-scalar key exactly, which keeps this change additive for every shape already covered.
 */
function canonicalizeBucketWidth(text: string): string {
  const parts = text
    .trim()
    .split(/\s+/)
    .filter((p) => p.length > 0);

  let months = 0n;
  const rest: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const value = parts[i];
    const unit = parts[i + 1];
    if (
      value !== undefined &&
      unit !== undefined &&
      /^[+-]?\d+$/.test(value) &&
      CALENDAR_UNIT_RE.test(unit)
    ) {
      months += BigInt(value) * (YEAR_UNIT_RE.test(unit) ? 12n : 1n);
      i++; // consume the unit token too
      continue;
    }
    if (value !== undefined) rest.push(value);
  }

  // No calendar unit: behave exactly as before, so existing keys are untouched.
  if (months === 0n) return canonicalizeInterval(text);

  const remainder = rest.join(' ');
  const tail = remainder.length > 0 ? canonicalizeInterval(remainder) : 'us:0';
  // A remainder we cannot canonicalise cleanly must not be silently dropped — quarantine the whole
  // value rather than emit a key that claims more precision than we have.
  if (!tail.startsWith('us:')) return `raw:${text.trim().toLowerCase().replace(/\s+/g, ' ')}`;

  return `mon:${months.toString()}|${tail}`;
}

/** One aggregate output column, e.g. `avg(value) AS avg_value`. */
export interface CaggAggregateFacet {
  /** Lower-cased function name, e.g. `avg`. */
  readonly fn: string;
  /** The aggregated column, or `undefined` for `count(*)`. */
  readonly column?: string;
  /** Output alias. */
  readonly as: string;
}

/**
 * One non-bucket GROUP BY key as it appears in the SELECT list, e.g. `sensor_id` or
 * `sensor_id AS sid`.
 *
 * The alias is part of the facet because it is part of the VIEW'S PUBLIC SHAPE. An aggregate whose
 * grain is unchanged but whose output column was renamed is a breaking change for every query
 * reading it, so reporting that as "no drift" would be exactly the false green this module exists
 * to prevent.
 */
export interface CaggGroupFacet {
  /** The grouped column, unquoted and folded like any other identifier. */
  readonly column: string;
  /** Output alias, present only when the SELECT list actually aliased the column. */
  readonly as?: string;
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
  /**
   * Output alias of the bucket column, e.g. `bucket`. Part of the view's public shape for the same
   * reason {@link CaggGroupFacet.as} is: renaming it breaks every reader. `undefined` only when the
   * SELECT list carried no `AS` at all, which the server does not emit.
   */
  readonly bucketAlias?: string;
  /** Source relation as `schema.name`, schema defaulted to `public`. Use for display, not equality. */
  readonly source: string;
  /** The source relation's name alone — what equality falls back to when a schema was not written. */
  readonly sourceName: string;
  /**
   * Whether the definition actually wrote the schema. See {@link RelationParts.schemaExplicit}: a
   * bare `FROM readings` must NOT be assumed to mean `public.readings`, because PostgreSQL omits any
   * schema on the `search_path`.
   */
  readonly sourceSchemaExplicit: boolean;
  /** GROUP BY keys BESIDES the time bucket, as an unordered set. */
  readonly groupBy: readonly CaggGroupFacet[];
  /** Aggregate output columns, ordered by alias so ordering is not spurious drift. */
  readonly aggregates: readonly CaggAggregateFacet[];
}

/** A relation split into the parts comparison needs, plus whether the schema was actually written. */
interface RelationParts {
  /** Canonical `schema.name`, schema defaulted to `public`. For messages and display. */
  readonly canonical: string;
  /** The relation name alone, folded. */
  readonly name: string;
  /**
   * Whether the definition QUALIFIED the relation. False for a bare `FROM readings`.
   *
   * This is the crux of the non-public-schema false positive. PostgreSQL omits a schema that is on
   * the `search_path` — not only `public`. With a hypertable in schema `metrics` and
   * `search_path = metrics, public` (an ordinary deployment), the server renders
   * `FROM sensor_reading` while the declared side always renders `"metrics"."sensor_reading"`
   * (`sql/hypertable.ts` `parseTable`). Defaulting the bare form to `public` made those
   * `public.sensor_reading` vs `metrics.sensor_reading` — both parse, so there is no fallback to
   * `not-compared`, and step 2 emits a BLOCKING advisory on a database `push` just converged.
   */
  readonly schemaExplicit: boolean;
}

/**
 * Canonicalise a possibly-qualified relation, keeping enough information to compare it safely.
 *
 * Two bugs lived here. `unquote` alone treats `"public"."readings"` as ONE quoted token and yields
 * the garbage `public"."readings`. And even unquoted correctly, `public.readings` does not equal the
 * server's `readings` — PostgreSQL omits the schema when it is on the search_path, while the
 * declared side renders it qualified. Either one reports a converged aggregate as drift, which the
 * live round-trip test caught: `source readings vs public"."readings`.
 *
 * Same lesson as `normalizeObject` in `lint.ts` — comparing object names needs ONE normalisation,
 * applied to both sides.
 */
function normalizeRelation(raw: string): RelationParts {
  const parts: string[] = [];
  // Parallel to `parts`: whether THAT part carried a double quote. Tracked during the walk because
  // the quotes are stripped as we go and cannot be recovered afterwards.
  const quoted: boolean[] = [];
  let buf = '';
  let sawQuote = false;
  let inQuote = false;
  const flush = (): void => {
    parts.push(buf);
    quoted.push(sawQuote);
    buf = '';
    sawQuote = false;
  };
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      if (inQuote && raw[i + 1] === '"') {
        buf += '"';
        i++;
        continue;
      }
      inQuote = !inQuote;
      sawQuote = true;
      continue;
    }
    if (ch === '.' && !inQuote) {
      flush();
      continue;
    }
    buf += ch;
  }
  flush();
  // Each part is normalised the same way as any other identifier: the server folds an unquoted
  // schema or table, so `"Public"."readings"` and `public.readings` must land on one string.
  // Filtering keeps `quoted` aligned by carrying the flag through the same pass.
  const kept = parts
    .map((p, i) => ({ text: p.trim(), wasQuoted: quoted[i] === true }))
    .filter((p) => p.text.length > 0);
  if (kept.length === 0) {
    const bare = raw.trim();
    return { canonical: bare, name: bare, schemaExplicit: false };
  }
  const cleaned = kept.map((p) => p.text);
  const quotedParts = kept.map((p) => p.wasQuoted);
  // Quoting is decided PER PART, not over the whole string. A single `wasQuoted` flag over `raw`
  // meant mixed quoting like `public."Sensor"` folded both parts the same way — so an unquoted
  // schema kept its case because the TABLE happened to be quoted, and vice versa. PostgreSQL folds
  // each identifier independently, so this must too.
  //
  // `quoted` is tracked while splitting rather than re-derived, because by this point the quotes
  // have already been stripped from `parts` and are no longer visible.
  const fold = (v: string, wasQuoted: boolean): string => (wasQuoted ? v : v.toLowerCase());
  const nameIdx = cleaned.length - 1;
  const schemaIdx = cleaned.length - 2;
  const name = fold(cleaned[nameIdx] ?? '', quotedParts[nameIdx] === true);
  const schemaExplicit = cleaned.length > 1;
  const schema = schemaExplicit
    ? fold(cleaned[schemaIdx] ?? 'public', quotedParts[schemaIdx] === true)
    : 'public';
  return { canonical: `${schema}.${name}`, name, schemaExplicit };
}

/**
 * Canonicalise an identifier the way PostgreSQL itself does: a QUOTED identifier keeps its case, an
 * UNQUOTED one folds to lower case.
 *
 * Measured on PG17/TSDB 2.29.1 — declaring `AS Bucket` / `AS AvgValue` unquoted and reading
 * `view_definition` back returns `AS bucket` / `AS avgvalue`. Stripping quotes without folding
 * therefore compares `AvgValue` against `avgvalue` and reports drift on an aggregate nobody
 * changed, which is the one outcome this module exists to prevent. Found by adversarial review
 * before merge, then verified against a live server rather than taken on trust.
 */
function normaliseIdent(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t.slice(1, -1).replace(/""/g, '"'); // quoted: case is significant
  }
  return t.toLowerCase(); // unquoted: the server folded it, so we must too
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
  /^time_bucket\( ?(?:'([^']*)'::interval|INTERVAL '([^']*)') ?, ?("(?:[^"]|"")+"|[A-Za-z_][\w$]*) ?\)$/i;

/** `avg(value) AS avg_value`, `count(*) AS n`. Deliberately does NOT accept nested expressions. */
const AGG_RE =
  /^([A-Za-z_][\w$]*)\( ?(\*|"(?:[^"]|"")+"|[A-Za-z_][\w$]*) ?\) AS ("(?:[^"]|"")+"|[A-Za-z_][\w$]*)$/i;

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

  // Split on literal keywords with indexOf rather than a regex. `definition` is `pg_get_viewdef`
  // output — genuinely uncontrolled input that `check` runs on every aggregate — and CodeQL
  // correctly flagged even the whitespace-free form `/^SELECT (.+?) FROM (.+?) GROUP BY (.+)$/`
  // as polynomial: two lazy groups separated by literals means the engine rescans for each
  // separator from every position. Replacing `\s+` with single spaces removed one source of
  // backtracking and left this one, so the regex goes entirely.
  //
  // indexOf is O(n) with no backtracking at all, and the code reads more plainly for it. Uses the
  // FIRST ` FROM ` and the LAST ` GROUP BY `, which is right for the shapes this parser accepts:
  // subqueries and joins are rejected before we get here, so there is exactly one of each.
  if (!/^SELECT /i.test(sql)) return undefined;
  const fromAt = sql.toUpperCase().indexOf(' FROM ');
  const groupAt = sql.toUpperCase().lastIndexOf(' GROUP BY ');
  if (fromAt === -1 || groupAt === -1 || groupAt <= fromAt) return undefined;

  const selectList = sql.slice('SELECT '.length, fromAt).trim();
  const fromPart = sql.slice(fromAt + ' FROM '.length, groupAt).trim();
  const groupPart = sql.slice(groupAt + ' GROUP BY '.length).trim();
  if (selectList.length === 0 || fromPart.length === 0 || groupPart.length === 0) return undefined;

  // A single relation only — a comma here is an implicit join. Dots ARE allowed: a qualified
  // `"public"."readings"` is one relation, and normalizeRelation canonicalises it.
  // Whitespace is rejected too, not just commas and parens. `FROM sensor_reading r` otherwise
  // survived and yielded the relation `public.sensor_reading r`, which can never equal the server's
  // `public.sensor_reading` — and once step 2 maps inequality to a blocking `not-expressible`, a
  // declaration written with a table alias (or `FROM ONLY t`) turns a CONVERGED database's `check`
  // permanently red with no way to converge it. Refusing to parse yields `not-compared` instead,
  // which is honest.
  if (/[,()\s]/.test(fromPart)) return undefined;
  const source = normalizeRelation(fromPart);

  const items = splitTopLevel(selectList);
  if (items === undefined || items.length < 2) return undefined;

  // The first item must be the time bucket; that is the shape this library emits, and an aggregate
  // whose bucket is elsewhere is one we do not claim to understand.
  const first = items[0];
  if (first === undefined) return undefined;
  // Same treatment as the structural split: find the LAST ` AS ` by index rather than with a lazy
  // group. The alias cannot contain ` AS ` unless quoted, and a quoted alias is matched whole by
  // BUCKET_RE's own pattern, so the last occurrence is the separator.
  const asAt = first.toUpperCase().lastIndexOf(' AS ');
  const bucketExpr = (asAt === -1 ? first : first.slice(0, asAt)).trim();
  // The alias was previously sliced off and thrown away, so renaming the bucket column compared
  // equal — a breaking change to the view's public shape reported as no drift.
  const bucketAliasRaw = asAt === -1 ? undefined : first.slice(asAt + ' AS '.length).trim();
  const bm = BUCKET_RE.exec(bucketExpr);
  if (bm === null) return undefined;
  const bucketWidth = (bm[1] ?? bm[2] ?? '').trim();
  const timeColumnRaw = bm[3];
  if (bucketWidth.length === 0 || timeColumnRaw === undefined) return undefined;

  const groupBy: CaggGroupFacet[] = [];
  const aggregates: CaggAggregateFacet[] = [];

  for (const item of items.slice(1)) {
    const agg = AGG_RE.exec(item);
    if (agg !== null) {
      const [, fn, arg, alias] = agg;
      if (fn === undefined || arg === undefined || alias === undefined) return undefined;
      aggregates.push({
        fn: fn.toLowerCase(),
        ...(arg === '*' ? {} : { column: normaliseIdent(arg) }),
        as: normaliseIdent(alias),
      });
      continue;
    }
    // Not an aggregate — must be a plain grouped column, optionally aliased.
    const plain =
      /^("(?:[^"]|"")+"|[A-Za-z_][\w$]*)(?:\s+AS\s+("(?:[^"]|"")+"|[A-Za-z_][\w$]*))?$/i.exec(item);
    if (plain === null || plain[1] === undefined) return undefined;
    // plain[2] — the alias — was captured by this regex but never stored, so `sensor_id` and
    // `sensor_id AS sid` produced identical facets.
    const alias = plain[2];
    groupBy.push({
      column: normaliseIdent(plain[1]),
      ...(alias === undefined ? {} : { as: normaliseIdent(alias) }),
    });
  }

  if (aggregates.length === 0) return undefined;

  // Cross-check the GROUP BY clause against the grouped columns we inferred from the SELECT list.
  // The server expands positional refs, so the bucket appears here as its full expression; every
  // OTHER key must be one of the plain columns above. A key we cannot account for means the parse
  // is incomplete, so refuse.
  const groupItems = splitTopLevel(groupPart);
  if (groupItems === undefined) return undefined;
  // Keyed on the COLUMN, not the alias: the GROUP BY clause names the underlying column, never the
  // SELECT-list alias (Postgres does allow an output-name reference, but the server re-renders it
  // as the column, which is the form this cross-check sees).
  const accountedFor = new Set(groupBy.map((g) => g.column));
  for (const key of groupItems) {
    const bare = key.replace(/^\((.*)\)$/s, '$1').trim();
    if (BUCKET_RE.test(bare)) continue; // the bucket itself
    if (/^\d+$/.test(bare)) continue; // an unexpanded positional reference
    if (accountedFor.has(normaliseIdent(bare))) continue;
    return undefined;
  }

  return {
    bucketWidth: canonicalizeBucketWidth(bucketWidth),
    timeColumn: normaliseIdent(timeColumnRaw),
    ...(bucketAliasRaw === undefined ? {} : { bucketAlias: normaliseIdent(bucketAliasRaw) }),
    source: source.canonical,
    sourceName: source.name,
    sourceSchemaExplicit: source.schemaExplicit,
    groupBy: [...groupBy].sort(
      (a, b) => a.column.localeCompare(b.column) || (a.as ?? '').localeCompare(b.as ?? ''),
    ),
    aggregates: [...aggregates].sort((a, b) => a.as.localeCompare(b.as)),
  };
}

/**
 * True when two aggregates are structurally the same. Order-insensitive by construction.
 *
 * Compared FIELD BY FIELD rather than by `JSON.stringify`. Stringify equality was safe only because
 * both sides came from {@link extractCaggFacets}, which always emits keys in one order — but this is
 * public API, so a caller constructing a `CaggFacets` literal by hand (different key order, or
 * `column: undefined` written explicitly rather than omitted) would get a spurious `false` and, in
 * step 2, spurious drift. Optional fields are compared through `?? undefined` so "absent" and
 * "explicitly undefined" are one value.
 */
export function caggFacetsEqual(a: CaggFacets, b: CaggFacets): boolean {
  // Source equality is asymmetric on purpose. Compare the FULL `schema.name` only when BOTH sides
  // wrote a schema; if either is bare, compare the relation name alone. PostgreSQL omits any schema
  // on the `search_path`, so a bare `FROM sensor_reading` from the server against a declared
  // `"metrics"."sensor_reading"` is the SAME relation rendered two ways — and defaulting the bare
  // form to `public` made that a blocking advisory on a just-converged database.
  //
  // The residual cost is a false NEGATIVE: moving a relation between schemas is missed when one side
  // is unqualified. That trade is deliberate and the right way round — this module's contract is that
  // a spurious failure on a converged database is the one outcome worse than admitting we did not
  // look, because a gate that cries wolf gets switched off.
  const sourceEqual =
    a.sourceSchemaExplicit && b.sourceSchemaExplicit
      ? a.source === b.source
      : a.sourceName === b.sourceName;

  if (
    a.bucketWidth !== b.bucketWidth ||
    a.timeColumn !== b.timeColumn ||
    (a.bucketAlias ?? undefined) !== (b.bucketAlias ?? undefined) ||
    !sourceEqual ||
    a.groupBy.length !== b.groupBy.length ||
    a.aggregates.length !== b.aggregates.length
  ) {
    return false;
  }
  // Both sides are sorted by extractCaggFacets, so a positional walk is an unordered-set compare.
  for (let i = 0; i < a.groupBy.length; i++) {
    const x = a.groupBy[i];
    const y = b.groupBy[i];
    if (x === undefined || y === undefined) return false;
    if (x.column !== y.column || (x.as ?? undefined) !== (y.as ?? undefined)) return false;
  }
  for (let i = 0; i < a.aggregates.length; i++) {
    const x = a.aggregates[i];
    const y = b.aggregates[i];
    if (x === undefined || y === undefined) return false;
    if (x.fn !== y.fn || x.as !== y.as || (x.column ?? undefined) !== (y.column ?? undefined)) {
      return false;
    }
  }
  return true;
}
