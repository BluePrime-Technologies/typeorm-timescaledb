import { setTimeColumn } from './metadata-store.js';

/**
 * Marks the time/partition column of a hypertable. Records the decorated property
 * name as the entity's time column (no prototype mutation).
 */
export function TimeColumn(): PropertyDecorator {
  return (target, propertyKey) => {
    setTimeColumn(target.constructor, String(propertyKey));
  };
}
