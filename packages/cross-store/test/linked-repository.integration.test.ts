import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { Column, DataSource, Entity, PrimaryColumn } from 'typeorm';
import { Resolve, ReferenceRegistry, CrossStoreErrorCode } from '../src/index.js';
import { DataSourceAdapter, createManyResolved, verifyReferences } from '../src/typeorm.js';

/**
 * M3.4b — the linked-repository write path against REAL TypeORM across two SEPARATE instances: a
 * "canonical" store holding accounts and an "events" store where the referencing LedgerEntry is
 * written. Proves validate-then-write inside the caller's transaction (a dangling reference rolls
 * back the local write) and the verifyReferences reconciliation sweep. Skips unless TIMESCALE_IMAGE.
 */
const IMAGE = process.env.TIMESCALE_IMAGE;
const d = IMAGE ? describe : describe.skip;

// The events-store entity: a TypeORM entity that ALSO carries a cross-store @Resolve reference.
class LedgerEntry {}
Entity('ledger_entry')(LedgerEntry);
PrimaryColumn({ type: 'text' })(LedgerEntry.prototype, 'id');
Column({ type: 'text', nullable: true })(LedgerEntry.prototype, 'accountId');
Resolve('canonical.accounts.id')(LedgerEntry.prototype, 'accountId');

interface LedgerRow {
  id: string;
  accountId: string | null;
}
function entry(id: string, accountId: string | null): LedgerRow {
  return Object.assign(new LedgerEntry(), { id, accountId });
}

const ACCOUNTS = { store: 'canonical', table: 'accounts', column: 'id' };

async function boot(): Promise<StartedTestContainer> {
  return new GenericContainer(IMAGE as string)
    .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'test' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
}

d('linked-repository write path over two separate instances', () => {
  let canonicalC: StartedTestContainer;
  let eventsC: StartedTestContainer;
  let canonicalDS: DataSource;
  let eventsDS: DataSource;
  let registry: ReferenceRegistry;
  let canonical: DataSourceAdapter;

  beforeAll(async () => {
    [canonicalC, eventsC] = await Promise.all([boot(), boot()]);
    canonicalDS = await new DataSource({
      type: 'postgres',
      host: canonicalC.getHost(),
      port: canonicalC.getMappedPort(5432),
      username: 'postgres',
      password: 'test',
      database: 'test',
    }).initialize();
    eventsDS = await new DataSource({
      type: 'postgres',
      host: eventsC.getHost(),
      port: eventsC.getMappedPort(5432),
      username: 'postgres',
      password: 'test',
      database: 'test',
      entities: [LedgerEntry],
      synchronize: true,
    }).initialize();

    await canonicalDS.query('CREATE TABLE accounts (id text PRIMARY KEY)');
    await canonicalDS.query(`INSERT INTO accounts (id) VALUES ('a'), ('b')`);

    registry = new ReferenceRegistry().register({ ...ACCOUNTS, targetIsAppendOnly: true });
    canonical = new DataSourceAdapter({ store: 'canonical', runner: canonicalDS });
  }, 300_000);

  afterAll(async () => {
    await canonicalDS?.destroy();
    await eventsDS?.destroy();
    await Promise.all([canonicalC?.stop(), eventsC?.stop()]);
  });

  const opts = () => ({ registry, adapters: [canonical] });

  it('validates the cross-store reference, then writes to the local store', async () => {
    await eventsDS.query('DELETE FROM ledger_entry');
    await eventsDS.transaction((mgr) => createManyResolved(mgr, [entry('e1', 'a')], opts()));
    const rows = await eventsDS.query('SELECT id FROM ledger_entry');
    expect(rows.map((r: { id: string }) => r.id)).toEqual(['e1']);
  });

  it('rolls back the local write when a reference is unresolved (validate-then-write in the caller txn)', async () => {
    await eventsDS.query('DELETE FROM ledger_entry');
    await expect(
      eventsDS.transaction((mgr) =>
        createManyResolved(mgr, [entry('e2', 'a'), entry('e3', 'ghost')], opts()),
      ),
    ).rejects.toMatchObject({ code: CrossStoreErrorCode.REFERENCE_NOT_FOUND });
    // the whole transaction rolled back — neither the valid nor the invalid row persisted
    const rows = await eventsDS.query('SELECT count(*)::int AS n FROM ledger_entry');
    expect(rows[0].n).toBe(0);
  });

  it('verifyReferences finds a reference that went dangling after the write', async () => {
    await eventsDS.query('DELETE FROM ledger_entry');
    // write with 'b' valid, then simulate the (non-append-only) account being removed
    await eventsDS.transaction((mgr) => createManyResolved(mgr, [entry('e4', 'b')], opts()));
    await canonicalDS.query(`DELETE FROM accounts WHERE id = 'b'`);
    const persisted = await eventsDS.getRepository(LedgerEntry).find();
    const { dangling, unavailable } = await verifyReferences(persisted, opts());
    expect(dangling).toHaveLength(1);
    expect(dangling[0]?.verdict.status).toBe('not_found');
    expect(unavailable).toEqual([]);
    // restore for isolation
    await canonicalDS.query(`INSERT INTO accounts (id) VALUES ('b')`);
  });
});
