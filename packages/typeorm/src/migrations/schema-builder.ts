import type { QueryRunner } from 'typeorm';
import {
  classifyOperation,
  compilePlan,
  type AddCompressionPolicyInput,
  type AlterColumnstoreConfigInput,
  type AlterPolicyInput,
  type ColumnstorePolicyInput,
  type CompiledPlan,
  type ContinuousAggregatePolicyInput,
  type CreateContinuousAggregateInput,
  type CreateHypertableInput,
  type Operation,
  type Plan,
  type RemovePolicyInput,
  type RenameTableInput,
  type RetentionPolicyInput,
  type SetChunkIntervalInput,
} from '@blueprime/timescaledb-core';

/**
 * Fluent, hand-authoring surface for TimescaleDB DDL — the **Tier-B** authoring tier of the migration
 * engine. Compose an ordered list of operations by chaining typed methods, then run them straight
 * inside a normal TypeORM migration via {@link up}/{@link down}, or extract the SQL with {@link build}.
 *
 * It defers **entirely** to the core compile choke point (`compileOperation`, via `compilePlan`), so
 * hand-authored SQL is byte-identical to what the diff/generate paths emit — the builder adds structure
 * and ergonomics, never SQL. Each method takes the matching `@blueprime/timescaledb-core` builder input
 * and returns `this` for chaining; construction applies no defaults beyond the core builders' own.
 *
 * The builder is mutable: {@link up} and {@link down} each recompile from the operations queued **at
 * call time**. Use one builder instance for both directions (as in the example) and do not mutate it
 * between calling `up` and `down`, or `down` would undo a different operation set than `up` applied.
 *
 * @example
 * ```ts
 * export class Init1700000000000 implements MigrationInterface {
 *   private readonly schema = new TimescaleSchemaBuilder()
 *     .createHypertable({ table: 'metric', timeColumn: 'ts', chunkInterval: '1 day' })
 *     .addRetentionPolicy({ table: 'metric', dropAfter: '90 days' });
 *   up = (qr: QueryRunner) => this.schema.up(qr);
 *   down = (qr: QueryRunner) => this.schema.down(qr);
 * }
 * ```
 */
export class TimescaleSchemaBuilder {
  private readonly ops: Operation[] = [];

  /** The operations queued so far, in insertion order. A defensive copy — mutate via the methods. */
  get operations(): readonly Operation[] {
    return [...this.ops];
  }

  /**
   * Append a pre-built {@link Operation} (escape hatch for a kind without a dedicated method). The
   * operation is shallow-copied on ingress, so mutating the argument afterwards cannot change queued
   * state (matches the typed methods, which build a fresh object via spread).
   */
  add(operation: Operation): this {
    this.ops.push({ ...operation });
    return this;
  }

  /** Convert a plain table into a hypertable (+ optional space dimension). */
  createHypertable(input: CreateHypertableInput): this {
    return this.add({ ...input, kind: 'createHypertable' });
  }

  /** Enable the columnstore (+ optional auto-convert/compression policy). */
  addColumnstorePolicy(input: ColumnstorePolicyInput): this {
    return this.add({ ...input, kind: 'addColumnstorePolicy' });
  }

  /** Add a data-retention (drop-chunks) policy. */
  addRetentionPolicy(input: RetentionPolicyInput): this {
    return this.add({ ...input, kind: 'addRetentionPolicy' });
  }

  /** Create a continuous aggregate (`WITH NO DATA`). */
  createContinuousAggregate(input: CreateContinuousAggregateInput): this {
    return this.add({ ...input, kind: 'createContinuousAggregate' });
  }

  /** Attach an automatic refresh policy to a continuous aggregate. */
  addContinuousAggregatePolicy(input: ContinuousAggregatePolicyInput): this {
    return this.add({ ...input, kind: 'addContinuousAggregatePolicy' });
  }

  /** Add ONLY the compression policy job to an already-enabled columnstore. */
  addCompressionPolicy(input: AddCompressionPolicyInput): this {
    return this.add({ ...input, kind: 'addCompressionPolicy' });
  }

  /** Change a compression policy's `after` threshold (remove-then-add). */
  alterCompressionPolicy(input: AlterPolicyInput): this {
    return this.add({ ...input, kind: 'alterCompressionPolicy' });
  }

  /** Change a retention policy's `drop_after` threshold (remove-then-add). */
  alterRetentionPolicy(input: AlterPolicyInput): this {
    return this.add({ ...input, kind: 'alterRetentionPolicy' });
  }

  /** Rename a hypertable's underlying table (catalog-only). */
  renameHypertable(input: RenameTableInput): this {
    return this.add({ ...input, kind: 'renameHypertable' });
  }

  /** Change the time-dimension chunk interval (`set_chunk_time_interval`). */
  setChunkInterval(input: SetChunkIntervalInput): this {
    return this.add({ ...input, kind: 'setChunkInterval' });
  }

  /** Change an existing columnstore's segment-by/order-by config. */
  alterColumnstoreConfig(input: AlterColumnstoreConfigInput): this {
    return this.add({ ...input, kind: 'alterColumnstoreConfig' });
  }

  /** Remove a retention policy (`down` re-adds it at `restoreAfter`). */
  removeRetentionPolicy(input: RemovePolicyInput): this {
    return this.add({ ...input, kind: 'removeRetentionPolicy' });
  }

  /** Remove a compression policy (`down` re-adds it at `restoreAfter`). */
  removeCompressionPolicy(input: RemovePolicyInput): this {
    return this.add({ ...input, kind: 'removeCompressionPolicy' });
  }

  /**
   * The queued operations as a safety-classified {@link Plan} — symmetric with the diff engine, so a
   * caller can inspect each step's {@link import('@blueprime/timescaledb-core').SafetyClass} before running.
   */
  toPlan(): Plan {
    return { steps: this.ops.map((operation) => ({ operation, ...classifyOperation(operation) })) };
  }

  /**
   * The reversible SQL for the queued operations: `up` in insertion order, `down` each op's own
   * reversible inverse with the operation sequence reversed (never destructive) — the same assembly
   * `planToMigration` uses. An empty builder yields empty `up`/`down`.
   */
  build(): CompiledPlan {
    return compilePlan(this.toPlan());
  }

  /** Run the queued operations' `up` SQL, one statement per `queryRunner.query()` call, in order. */
  async up(queryRunner: QueryRunner): Promise<void> {
    for (const sql of this.build().up) await queryRunner.query(sql);
  }

  /** Run the queued operations' `down` SQL (reverse order), one statement per `queryRunner.query()`. */
  async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of this.build().down) await queryRunner.query(sql);
  }
}
