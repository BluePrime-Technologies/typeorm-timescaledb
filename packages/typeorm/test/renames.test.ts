import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { TimescaleError } from '@blueprime/timescaledb-core';
import { collectRenames, Hypertable, TimeColumn, HypertablePrimaryKey } from '../src/index.js';

// --- Fixtures: decorate classes via direct invocation (no decorator syntax), mirroring
// desired-state.test.ts's pattern. ---

class EventsV2 {}
Hypertable({ chunkInterval: '1 hour', renamedFrom: 'events' })(EventsV2);
TimeColumn()(EventsV2.prototype, 'ts');
HypertablePrimaryKey()(EventsV2.prototype, 'ts');

class Trade {}
Hypertable({ chunkInterval: '1 day' })(Trade); // no renamedFrom
TimeColumn()(Trade.prototype, 'time');
HypertablePrimaryKey()(Trade.prototype, 'time');

class Qualified {}
Hypertable({ chunkInterval: '1 day', renamedFrom: 'analytics.old_qualified' })(Qualified);
TimeColumn()(Qualified.prototype, 'ts');
HypertablePrimaryKey()(Qualified.prototype, 'ts');

class SelfRename {}
Hypertable({ chunkInterval: '1 day', renamedFrom: 'self_rename' })(SelfRename);
TimeColumn()(SelfRename.prototype, 'ts');
HypertablePrimaryKey()(SelfRename.prototype, 'ts');

class ClaimsOld {}
Hypertable({ chunkInterval: '1 day', renamedFrom: 'shared_old' })(ClaimsOld);
TimeColumn()(ClaimsOld.prototype, 'ts');
HypertablePrimaryKey()(ClaimsOld.prototype, 'ts');

class AlsoClaimsOld {}
Hypertable({ chunkInterval: '1 day', renamedFrom: 'shared_old' })(AlsoClaimsOld);
TimeColumn()(AlsoClaimsOld.prototype, 'ts');
HypertablePrimaryKey()(AlsoClaimsOld.prototype, 'ts');

interface StubEntity {
  target: unknown;
  tableName: string;
  schema?: string;
}

function stubDataSource(entities: StubEntity[]): DataSource {
  return {
    isInitialized: true,
    entityMetadatas: entities.map((e) => ({ columns: [], ...e })),
  } as unknown as DataSource;
}

describe('collectRenames', () => {
  it('returns an empty map when no entity declares renamedFrom', () => {
    const renames = collectRenames(stubDataSource([{ target: Trade, tableName: 'trades' }]));
    expect(renames.size).toBe(0);
  });

  it('maps the new (schema-qualified) table to the old one, resolved against the same schema', () => {
    const renames = collectRenames(stubDataSource([{ target: EventsV2, tableName: 'events_v2' }]));
    expect(renames.get('public.events_v2')).toBe('public.events');
  });

  it('respects an already schema-qualified renamedFrom value', () => {
    const renames = collectRenames(
      stubDataSource([{ target: Qualified, tableName: 'qualified', schema: 'analytics' }]),
    );
    expect(renames.get('analytics.qualified')).toBe('analytics.old_qualified');
  });

  it('mixes renamed and non-renamed entities', () => {
    const renames = collectRenames(
      stubDataSource([
        { target: EventsV2, tableName: 'events_v2' },
        { target: Trade, tableName: 'trades' },
      ]),
    );
    expect(renames.size).toBe(1);
    expect(renames.get('public.events_v2')).toBe('public.events');
  });

  it("throws when renamedFrom resolves to the entity's own (new) table name", () => {
    expect(() =>
      collectRenames(stubDataSource([{ target: SelfRename, tableName: 'self_rename' }])),
    ).toThrow(TimescaleError);
  });

  it('throws when two entities declare the same renamedFrom (ambiguous)', () => {
    expect(() =>
      collectRenames(
        stubDataSource([
          { target: ClaimsOld, tableName: 'claims_old' },
          { target: AlsoClaimsOld, tableName: 'also_claims_old' },
        ]),
      ),
    ).toThrow(/ambiguous rename/);
  });

  it('throws if the DataSource is not initialized', () => {
    const ds = { isInitialized: false, entityMetadatas: [] } as unknown as DataSource;
    expect(() => collectRenames(ds)).toThrow(TimescaleError);
  });
});
