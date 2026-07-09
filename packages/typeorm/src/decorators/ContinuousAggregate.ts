import type { ContinuousAggregateFn } from '@blueprime/timescaledb-core';
import {
  addAggregateColumn,
  addGroupColumn,
  setBucketColumn,
  setContinuousAggregate,
} from './metadata-store.js';
import type { CaggRefreshPolicy } from './metadata-store.js';

/**
 * An automatic refresh policy attached to a {@link ContinuousAggregate}. Public alias of
 * the metadata type — see {@link CaggRefreshPolicy} for the field docs.
 */
export type RefreshPolicyOptions = CaggRefreshPolicy;

type Ctor = abstract new (...args: never[]) => unknown;

/**
 * Options for {@link ContinuousAggregate}. A CAGG is declared as its own entity class
 * whose columns are the aggregate view's output; `source` points at the hypertable it
 * aggregates.
 */
export interface ContinuousAggregateOptions {
  /** The continuous-aggregate view name, optionally `schema.view`. */
  readonly name: string;
  /** The source `@Hypertable` entity class this CAGG aggregates. */
  readonly source: Ctor;
  /** Bucket width, e.g. `'1 hour'`. */
  readonly bucket: string;
  /**
   * `timescaledb.materialized_only`. Default `false` → real-time aggregation on.
   */
  readonly materializedOnly?: boolean;
  /** Source time **property** to bucket; defaults to the source's `@TimeColumn`. */
  readonly timeColumn?: string;
  /**
   * Automatic refresh policy. When set, the generated migration wires up
   * `add_continuous_aggregate_policy(...)` so the CAGG keeps itself up to date.
   */
  readonly refresh?: RefreshPolicyOptions;
}

/**
 * Marks a class as a TimescaleDB **continuous aggregate** over `source`. A CAGG is a
 * (materialized) view, not a table, so the class is **not** a TypeORM `@Entity` — it is
 * a pure metadata holder. Metadata is stored in a module-private WeakMap (no prototype
 * mutation); pass the CAGG classes to `generateTimescaleMigration(ds, { continuousAggregates })`
 * and it emits the `CREATE MATERIALIZED VIEW … WITH (timescaledb.continuous)` DDL.
 *
 * Output column names come from the decorated property names; `@GroupColumn` /
 * `@AggregateColumn.column` reference **source** columns (resolved via the source
 * entity, honouring its `@Column({ name })`).
 *
 * ```ts
 * @ContinuousAggregate({ name: 'reading_hourly', source: Reading, bucket: '1 hour' })
 * class ReadingHourly {
 *   @BucketColumn() bucket!: Date;
 *   @GroupColumn() sensor!: string;                       // grouped source column
 *   @AggregateColumn({ fn: 'avg', column: 'value' }) avgValue!: number;
 *   @AggregateColumn({ fn: 'count' }) samples!: number;
 * }
 * ```
 */
export function ContinuousAggregate(options: ContinuousAggregateOptions): ClassDecorator {
  return (target) => {
    setContinuousAggregate(target, {
      viewName: options.name,
      source: options.source,
      bucketInterval: options.bucket,
      ...(options.materializedOnly !== undefined && { materializedOnly: options.materializedOnly }),
      ...(options.timeColumn !== undefined && { timeColumn: options.timeColumn }),
      ...(options.refresh !== undefined && { refresh: options.refresh }),
    });
  };
}

/** Marks the property that receives the `time_bucket(...)` value of a continuous aggregate. */
export function BucketColumn(): PropertyDecorator {
  return (target, propertyKey) => {
    setBucketColumn(target.constructor, String(propertyKey));
  };
}

/**
 * Marks a property as an extra `GROUP BY` key. The source column is also projected as
 * an output column, unaliased — so its output name is the **source column's physical
 * name** (`@Column({ name })` if remapped), NOT this property name. This differs from
 * `@BucketColumn`/`@AggregateColumn`, whose output names are the property verbatim.
 */
export function GroupColumn(): PropertyDecorator {
  return (target, propertyKey) => {
    addGroupColumn(target.constructor, String(propertyKey));
  };
}

/** Options for {@link AggregateColumn}. */
export interface AggregateColumnOptions {
  /** Allow-listed aggregate function. */
  readonly fn: ContinuousAggregateFn;
  /** Source column **property** to aggregate; omit only for `count` → `count(*)`. */
  readonly column?: string;
}

/** Marks a property as an aggregate output column of a continuous aggregate. */
export function AggregateColumn(options: AggregateColumnOptions): PropertyDecorator {
  return (target, propertyKey) => {
    addAggregateColumn(target.constructor, String(propertyKey), options.fn, options.column);
  };
}
