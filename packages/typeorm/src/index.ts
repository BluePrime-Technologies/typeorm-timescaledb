/**
 * typeorm-timescaledb — a multi-DataSource-safe TimescaleDB integration for TypeORM.
 *
 * Hypertable metadata is declared with decorators that write only to a
 * module-private WeakMap — never a prototype, never TypeORM's global metadata.
 */
// Unified schema DSL — TypeORM's modeling surface, re-exported so users import only from here.
export * from './orm.js';

export { Hypertable, TimeColumn, HypertablePrimaryKey } from './decorators/index.js';
export { getTimescaleMetadata, hasTimescaleMetadata } from './decorators/index.js';
export { createTimescale } from './runtime/createTimescale.js';
export type { TimescaleContext, TimescaleRepository } from './runtime/createTimescale.js';

// Migration generation — Django/Prisma-style codegen from @Hypertable metadata.
export {
  generateTimescaleMigration,
  renderTimescaleMigration,
  createTimescaleMigration,
} from './migrations/index.js';
export type { GeneratedMigration, GenerateMigrationOptions } from './migrations/index.js';

// Re-export the core metadata model + validation so consumers need one import.
export {
  validateHypertableMetadata,
  parseHypertableOptions,
  TimescaleError,
  TimescaleErrorCode,
} from '@blueprime-technologies/timescaledb-core';
export type {
  HypertableOptions,
  ColumnstoreOptions,
  RetentionOptions,
  SpacePartitionOptions,
  TimescaleEntityMetadata,
} from '@blueprime-technologies/timescaledb-core';
