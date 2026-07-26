import {
  addColumnstorePolicySQL,
  addCompressionPolicySQL,
  addContinuousAggregatePolicySQL,
  addRetentionPolicySQL,
  alterCompressionPolicySQL,
  alterRetentionPolicySQL,
  setChunkIntervalSQL,
  createContinuousAggregateSQL,
  createHypertableSQL,
  renameHypertableSQL,
  type AddCompressionPolicyInput,
  type AlterPolicyInput,
  type SetChunkIntervalInput,
  type ColumnstorePolicyInput,
  type ContinuousAggregatePolicyInput,
  type CreateContinuousAggregateInput,
  type CreateHypertableInput,
  type MigrationStatement,
  type RenameTableInput,
  type RetentionPolicyInput,
} from './sql/index.js';
import { TimescaleError, TimescaleErrorCode } from './errors.js';

/**
 * The typed **migration operation IR** (M4.1).
 *
 * An {@link Operation} is a single, fully-resolved DDL action expressed as data: the same
 * fields the matching `@blueprime/timescaledb-core` SQL builder takes, tagged with a `kind`
 * discriminant. It is the shared vocabulary of the migration engine —
 *
 *   - **M4.1** compiles a decorator-derived `Operation[]` to SQL (the raw-SQL emit target;
 *     `generateTimescaleMigration` routes through it).
 *   - **M4.2** produces an `Operation[]` as the diff between desired (decorators) and current
 *     ({@link import('./schema-state.js').SchemaStateIR} from `introspect()`).
 *   - **M4.3** consumes the same `Operation[]` from other emit targets (TS classes, direct apply).
 *
 * Column/identifier names carried here are already **physical** (DB) names — property→column
 * resolution happens upstream (in the decorator/introspection layer), never inside the compile
 * core. Each variant carries its builder's input verbatim so the emitted SQL is byte-identical to
 * calling that builder directly; the operation model adds a name and a single choke point, not new
 * SQL. All SQL-safety (identifier allow-lists, interval validation, quoting) stays in the builders.
 *
 * Byte-identical rests on an invariant the builders already honour: **each builder reads only the
 * NAMED fields of its input** — it must never spread (`{ ...input }`) or enumerate (`Object.keys`)
 * the argument, or the operation's extra `kind` discriminant would leak into the emitted SQL. The
 * `toEqual` regression tests would catch a violation.
 */

/** Convert an existing table into a hypertable (+ optional space dimension). */
export interface CreateHypertableOperation extends CreateHypertableInput {
  readonly kind: 'createHypertable';
}

/** Enable the columnstore on a hypertable and, optionally, add an auto-convert policy. */
export interface AddColumnstorePolicyOperation extends ColumnstorePolicyInput {
  readonly kind: 'addColumnstorePolicy';
}

/** Add a data-retention (drop-chunks) policy to a hypertable. */
export interface AddRetentionPolicyOperation extends RetentionPolicyInput {
  readonly kind: 'addRetentionPolicy';
}

/** Create a continuous aggregate (flat or hierarchical) `WITH NO DATA`. */
export interface CreateContinuousAggregateOperation extends CreateContinuousAggregateInput {
  readonly kind: 'createContinuousAggregate';
}

/** Attach an automatic refresh policy to an existing continuous aggregate. */
export interface AddContinuousAggregatePolicyOperation extends ContinuousAggregatePolicyInput {
  readonly kind: 'addContinuousAggregatePolicy';
}

/** Add ONLY the compression policy job to a hypertable whose columnstore is already enabled
 * (closes the "columnstore enabled but no compression policy" drift; no `ALTER TABLE SET` re-assert). */
export interface AddCompressionPolicyOperation extends AddCompressionPolicyInput {
  readonly kind: 'addCompressionPolicy';
}

/** Change a compression policy's `after` threshold (remove-then-add; `down` restores `from`). */
export interface AlterCompressionPolicyOperation extends AlterPolicyInput {
  readonly kind: 'alterCompressionPolicy';
}

/** Change a retention policy's `drop_after` threshold (remove-then-add; `down` restores `from`). */
export interface AlterRetentionPolicyOperation extends AlterPolicyInput {
  readonly kind: 'alterRetentionPolicy';
}

/** Rename a hypertable's underlying table (catalog-only; `down` renames back to `from`). Emitted by
 * the M4.2 diff when a desired hypertable resolves to a current one via `renamedFrom`. */
export interface RenameHypertableOperation extends RenameTableInput {
  readonly kind: 'renameHypertable';
}

/** Change the time-dimension chunk interval (`set_chunk_time_interval`; `down` restores `from`). */
export interface SetChunkIntervalOperation extends SetChunkIntervalInput {
  readonly kind: 'setChunkInterval';
}

/**
 * The migration operation IR — a discriminated union over `kind`. Every variant that can be
 * emitted into a generated TimescaleDB migration today is represented; the union is the
 * extension point for future actions (e.g. jobs `add_job`/`alter_job`) as their emit paths land.
 */
export type Operation =
  | CreateHypertableOperation
  | AddColumnstorePolicyOperation
  | AddRetentionPolicyOperation
  | CreateContinuousAggregateOperation
  | AddContinuousAggregatePolicyOperation
  | AddCompressionPolicyOperation
  | AlterCompressionPolicyOperation
  | AlterRetentionPolicyOperation
  | RenameHypertableOperation
  | SetChunkIntervalOperation;

/** The set of {@link Operation} discriminants. */
export type OperationKind = Operation['kind'];

/**
 * Compile one {@link Operation} to its reversible {@link MigrationStatement} by delegating to the
 * matching core SQL builder. This is the **single SQL-generation choke point** for migration
 * emission: every emit target (raw SQL, TS classes, direct apply) routes through here, so no
 * emitter constructs TimescaleDB DDL on its own. The output is exactly what the underlying builder
 * produces for the same fields — the operation layer adds structure, never SQL.
 */
export function compileOperation(operation: Operation): MigrationStatement {
  switch (operation.kind) {
    case 'createHypertable':
      return createHypertableSQL(operation);
    case 'addColumnstorePolicy':
      return addColumnstorePolicySQL(operation);
    case 'addRetentionPolicy':
      return addRetentionPolicySQL(operation);
    case 'createContinuousAggregate':
      return createContinuousAggregateSQL(operation);
    case 'addContinuousAggregatePolicy':
      return addContinuousAggregatePolicySQL(operation);
    case 'addCompressionPolicy':
      return addCompressionPolicySQL(operation);
    case 'alterCompressionPolicy':
      return alterCompressionPolicySQL(operation);
    case 'alterRetentionPolicy':
      return alterRetentionPolicySQL(operation);
    case 'renameHypertable':
      return renameHypertableSQL(operation);
    case 'setChunkInterval':
      return setChunkIntervalSQL(operation);
    default: {
      // Exhaustiveness: if a new Operation variant is added without a case, this fails to compile.
      // At runtime it guards a caller that (via `any`) passes an unknown discriminant.
      const unhandled: never = operation;
      throw new TimescaleError(
        TimescaleErrorCode.INVALID_ARGUMENT,
        `unknown migration operation kind: ${String((unhandled as { kind?: unknown }).kind)}`,
      );
    }
  }
}

/**
 * Compile an ordered list of {@link Operation}s, preserving order. The caller owns cross-operation
 * ordering and the `up`/`down` assembly (e.g. reversing `down`); this only maps each operation
 * through {@link compileOperation}.
 */
export function compileOperations(operations: readonly Operation[]): readonly MigrationStatement[] {
  return operations.map((operation) => compileOperation(operation));
}
