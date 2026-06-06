import { addPrimaryKeyColumn } from './metadata-store.js';

/**
 * Marks a column as part of the hypertable's primary key. TimescaleDB requires
 * every unique/primary key to contain all partitioning columns, so the time
 * column must also carry this decorator; {@link validateHypertableMetadata}
 * enforces that rule. Records the property name (no prototype mutation).
 */
export function HypertablePrimaryKey(): PropertyDecorator {
  return (target, propertyKey) => {
    addPrimaryKeyColumn(target.constructor, String(propertyKey));
  };
}
