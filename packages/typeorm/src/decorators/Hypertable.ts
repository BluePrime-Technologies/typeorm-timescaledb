import { parseHypertableOptions } from '@blueprime/timescaledb-core';
import type { HypertableOptions } from '@blueprime/timescaledb-core';
import { setHypertableOptions } from './metadata-store.js';

/**
 * Marks a TypeORM entity as a TimescaleDB hypertable. Options are validated at
 * decoration time and stored in a module-private WeakMap (no prototype mutation).
 *
 * ```ts
 * @Hypertable({ chunkInterval: '7 days', columnstore: { segmentBy: ['symbol'] } })
 * @Entity('trades')
 * class Trade {
 *   @TimeColumn() @HypertablePrimaryKey() time!: Date;
 *   @HypertablePrimaryKey() symbol!: string;
 * }
 * ```
 */
export function Hypertable(options: HypertableOptions = {}): ClassDecorator {
  const parsed = parseHypertableOptions(options);
  return (target) => {
    setHypertableOptions(target, parsed);
  };
}
