import type { DataSource } from 'typeorm';
import {
  TimescaleError,
  TimescaleErrorCode,
  type ContinuousAggregateFn,
  type ContinuousAggregatePolicyInput,
  type CreateContinuousAggregateInput,
} from '@blueprime/timescaledb-core';
import {
  getContinuousAggregateMeta,
  hasContinuousAggregateMeta,
  getTimescaleMetadata,
  type ContinuousAggregateMeta,
} from '../decorators/index.js';

type Ctor = abstract new (...args: never[]) => unknown;

/**
 * Shared resolution of `@ContinuousAggregate` classes into the concrete builder inputs.
 *
 * Extracted from `generateTimescaleMigration` so the migration generator and the desired-state
 * compiler resolve CAGGs **the same way**. Two copies of this would drift — the hierarchical
 * property→column rules below are subtle enough that a divergence would surface as a
 * `column "sensorId" does not exist` failure at migration-run time, not at compile time.
 */
export interface ResolvedCagg {
  readonly meta: ContinuousAggregateMeta;
  /** Exactly the input `createContinuousAggregateSQL` takes. */
  readonly create: CreateContinuousAggregateInput;
  /** Present only when the decorator declared a refresh policy. */
  readonly refresh?: ContinuousAggregatePolicyInput;
  /** `true` when the source is another CAGG (hierarchical) rather than a hypertable. */
  readonly hierarchical: boolean;
  /**
   * `schema.view`, ALWAYS qualified (bare names default to `public`).
   *
   * Distinct from `create.view` on purpose. `create` feeds the SQL builder, which qualifies bare
   * names itself, so its fields stay exactly as declared and `generate.ts` keeps emitting
   * byte-identical SQL. The IR, by contrast, is compared against `introspect()`, which reports
   * `view_schema.view_name` — always qualified. Using the declared (bare) name in the IR made every
   * existing CAGG look ABSENT to the diff, which would emit a CREATE for a view that already exists.
   */
  readonly qualifiedView: string;
  /** `schema.table` (or `schema.view` when hierarchical), qualified to match `introspect()`. */
  readonly qualifiedSource: string;
}

/** Qualify a possibly-bare object name the way the SQL builder and `introspect()` both do. */
function qualify(name: string): string {
  return name.includes('.') ? name : `public.${name}`;
}

/**
 * Resolve declared CAGG classes, in **dependency order** (a hierarchical CAGG always follows the
 * CAGG it reads from).
 *
 * @throws {TimescaleError} on a class that is not decorated, a source that is neither a registered
 *   `@Hypertable` entity nor a `@ContinuousAggregate`, an unresolvable time column, duplicate
 *   output columns, or a circular source dependency.
 */
export function resolveContinuousAggregates(
  dataSource: DataSource,
  continuousAggregates: readonly Ctor[],
): ResolvedCagg[] {
  // De-dupe first: the termination check below compares against this length, so duplicates would
  // false-trip the circular-dependency error.
  const declared: Ctor[] = [...new Set<Ctor>(continuousAggregates)];
  const inSet = new Set<Ctor>(declared);
  const sourceInSet = (c: Ctor): Ctor | undefined => {
    const src = getContinuousAggregateMeta(c)?.source as Ctor | undefined;
    return src !== undefined && inSet.has(src) && hasContinuousAggregateMeta(src) ? src : undefined;
  };

  // Deterministic base order, then a topological pass so a child follows its parent.
  const byViewName = [...declared].sort((a, b) =>
    (getContinuousAggregateMeta(a)?.viewName ?? '').localeCompare(
      getContinuousAggregateMeta(b)?.viewName ?? '',
    ),
  );
  const ordered: Ctor[] = [];
  const emitted = new Set<Ctor>();
  let progress = true;
  while (ordered.length < byViewName.length && progress) {
    progress = false;
    for (const c of byViewName) {
      if (emitted.has(c)) continue;
      const dep = sourceInSet(c);
      if (dep === undefined || emitted.has(dep)) {
        ordered.push(c);
        emitted.add(c);
        progress = true;
      }
    }
  }
  if (ordered.length < byViewName.length) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      'continuous aggregates have a circular source dependency',
    );
  }

  const resolved = ordered.map((ctor) => resolveOne(dataSource, ctor));

  // De-duplication above is by CLASS IDENTITY, which does not catch two DIFFERENT classes declaring
  // the same view name — an easy copy-paste in a large entity tree. Both would miss the current
  // state, both would take the create branch, and `push --apply` would execute the first CREATE and
  // die on the second with `relation already exists`, mid-transaction. Refuse up front, naming both
  // classes — the same treatment `compileDesiredState` gives conflicting hypertable declarations.
  const byView = new Map<string, string>();
  for (const [i, r] of resolved.entries()) {
    const className = (ordered[i] as { name?: string }).name ?? 'class';
    const previous = byView.get(r.qualifiedView);
    if (previous !== undefined) {
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        `two continuous aggregates declare the same view name "${r.qualifiedView}" (${previous} and ${className}) — view names must be unique`,
        { view: r.qualifiedView },
      );
    }
    byView.set(r.qualifiedView, className);
  }

  return resolved;
}

function resolveOne(dataSource: DataSource, caggCtor: Ctor): ResolvedCagg {
  const meta = getContinuousAggregateMeta(caggCtor);
  if (!meta) {
    throw new TimescaleError(
      TimescaleErrorCode.INVALID_ARGUMENT,
      `${(caggCtor as { name?: string }).name ?? 'class'} was passed as a continuous aggregate but is not decorated with @ContinuousAggregate`,
    );
  }

  // Resolve the source: a hypertable @Entity (the common case) or, for a hierarchical CAGG,
  // another @ContinuousAggregate (its view). These produce the FROM target, the property->column
  // resolver, and the time-bucket source column.
  let sourceRef: string;
  let qualifiedSource: string;
  let srcToDb: (property: string) => string;
  let srcTimeProp: string | undefined;
  let sourceLabel: string;

  const sourceCagg = hasContinuousAggregateMeta(meta.source as Ctor)
    ? getContinuousAggregateMeta(meta.source as Ctor)
    : undefined;

  if (sourceCagg) {
    // Hierarchical: FROM the child's view, so every referenced column must be one of the CHILD's
    // OUTPUT names. The child's bucket and aggregate outputs are property-named verbatim, but a
    // child `@GroupColumn` is projected UNALIASED — its output is the child's *source* physical
    // column name. Resolving by identity would emit the property name whenever the child's source
    // hypertable remaps it with `@Column({ name })` (`sensorId` → `sensor_id`), producing
    // `column "sensorId" does not exist` and rolling back the whole migration.
    const childSourceEm = dataSource.entityMetadatas.find((e) => e.target === sourceCagg.source);
    const childDb = new Map<string, string>(
      (childSourceEm?.columns ?? []).map((col) => [col.propertyName, col.databaseName]),
    );
    const childGroupProps = new Set(sourceCagg.groupProperties);
    sourceRef = sourceCagg.viewName;
    qualifiedSource = qualify(sourceCagg.viewName);
    srcToDb = (property) =>
      childGroupProps.has(property) ? (childDb.get(property) ?? property) : property;
    srcTimeProp = meta.timeColumn ?? sourceCagg.bucketProperty;
    sourceLabel = sourceCagg.viewName;
  } else {
    const sourceEm = dataSource.entityMetadatas.find((e) => e.target === meta.source);
    const sourceName = (meta.source as { name?: string }).name ?? 'source';
    if (!sourceEm) {
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        `@ContinuousAggregate ${meta.viewName}: source ${sourceName} is neither a registered @Hypertable entity nor a @ContinuousAggregate`,
        { view: meta.viewName },
      );
    }
    const sourceHt = getTimescaleMetadata(meta.source as Ctor);
    if (!sourceHt) {
      throw new TimescaleError(
        TimescaleErrorCode.NOT_A_HYPERTABLE,
        `@ContinuousAggregate ${meta.viewName}: source ${sourceEm.tableName} is not a @Hypertable`,
        { view: meta.viewName, source: sourceEm.tableName },
      );
    }
    // Group/aggregate columns + the time column reference SOURCE columns — resolve
    // property -> databaseName via the source entity (honours @Column({ name })).
    const srcDb = new Map<string, string>(
      (sourceEm.columns ?? []).map((c) => [c.propertyName, c.databaseName]),
    );
    srcToDb = (property) => srcDb.get(property) ?? property;
    srcTimeProp = meta.timeColumn ?? sourceHt.timeColumn ?? sourceHt.options.timeColumn;
    sourceRef = sourceEm.schema ? `${sourceEm.schema}.${sourceEm.tableName}` : sourceEm.tableName;
    qualifiedSource = `${sourceEm.schema ?? 'public'}.${sourceEm.tableName}`;
    sourceLabel = sourceEm.tableName;
  }

  if (srcTimeProp === undefined) {
    throw new TimescaleError(
      TimescaleErrorCode.NO_TIME_COLUMN,
      `@ContinuousAggregate ${meta.viewName}: source ${sourceLabel} has no resolvable time column`,
      { view: meta.viewName },
    );
  }

  // Guard: the view's output columns must be mutually distinct, else Postgres rejects the view
  // with "column specified more than once". Surface it here with a clear message instead of a raw
  // driver error at migration-run time.
  const groupOutputs = meta.groupProperties.map(srcToDb);
  const outputNames = [
    meta.bucketProperty,
    ...groupOutputs,
    ...meta.aggregates.map((a) => a.property),
  ];
  const seen = new Set<string>();
  for (const name of outputNames) {
    if (seen.has(name)) {
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        `@ContinuousAggregate ${meta.viewName}: duplicate output column "${name}" — the time bucket, group columns, and aggregate columns must all have distinct names`,
        { view: meta.viewName },
      );
    }
    seen.add(name);
  }

  const create: CreateContinuousAggregateInput = {
    view: meta.viewName,
    source: sourceRef,
    timeColumn: srcToDb(srcTimeProp),
    bucketInterval: meta.bucketInterval,
    // Output-column names come from the CAGG property names (verbatim).
    bucketAlias: meta.bucketProperty,
    ...(meta.materializedOnly !== undefined && { materializedOnly: meta.materializedOnly }),
    groupBy: groupOutputs,
    aggregates: meta.aggregates.map((a) => ({
      fn: a.fn as ContinuousAggregateFn,
      ...(a.column !== undefined && { column: srcToDb(a.column) }),
      as: a.property,
    })),
  };

  return {
    meta,
    create,
    hierarchical: sourceCagg !== undefined,
    qualifiedView: qualify(meta.viewName),
    qualifiedSource,
    ...(meta.refresh && {
      refresh: {
        view: meta.viewName,
        startOffset: meta.refresh.startOffset,
        endOffset: meta.refresh.endOffset,
        // Always pass schedule_interval (default = the bucket width): TimescaleDB 2.18, our
        // supported floor, has no `add_continuous_aggregate_policy` overload that omits it.
        scheduleInterval: meta.refresh.scheduleInterval ?? meta.bucketInterval,
      },
    }),
  };
}
