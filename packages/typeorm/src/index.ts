/**
 * typeorm-timescaledb — a multi-DataSource-safe TimescaleDB integration for TypeORM.
 *
 * Hypertable metadata is declared with decorators that write only to a
 * module-private WeakMap — never a prototype, never TypeORM's global metadata.
 */
export { Hypertable, TimeColumn, HypertablePrimaryKey } from './decorators/index.js';
export { getTimescaleMetadata, hasTimescaleMetadata } from './decorators/index.js';
export { createTimescale } from './runtime/createTimescale.js';
export type { TimescaleContext, TimescaleRepository } from './runtime/createTimescale.js';

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
