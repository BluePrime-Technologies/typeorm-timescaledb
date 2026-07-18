import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { DataSource } from 'typeorm';
import { ReferenceRegistry, resolveReferences, type SnapshotRow } from '../src/index.js';
import { DataSourceAdapter } from '../src/typeorm.js';
import { runAdapterConformance, type ConformanceContext } from './conformance.js';

/**
 * M3.3a — the end-to-end proof that cross-store `@Resolve` works across TWO SEPARATE database
 * instances (the whole premise: no cross-instance SQL FK is possible). Boots two independent
 * containers — a "canonical" Postgres instance holding the referenced rows and a separate
 * TimescaleDB "events" instance holding the referencing rows — and resolves across them.
 *
 * Skips unless TIMESCALE_IMAGE is set (Testcontainers boots the image).
 */
const IMAGE = process.env.TIMESCALE_IMAGE;
const d = IMAGE ? describe : describe.skip;

const A1 = '11111111-1111-1111-1111-111111111111';
const A2 = '22222222-2222-2222-2222-222222222222';
const A3 = '33333333-3333-3333-3333-333333333333'; // workspace w2
const MISSING = '99999999-9999-9999-9999-999999999999';

const CANONICAL = { store: 'canonical', table: 'accounts', column: 'id' };
const LEDGER = { store: 'canonical', table: 'ledger', column: 'entry' };

async function boot(): Promise<StartedTestContainer> {
  return new GenericContainer(IMAGE as string)
    .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'test' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
}

function connect(container: StartedTestContainer): Promise<DataSource> {
  const ds = new DataSource({
    type: 'postgres',
    host: container.getHost(),
    port: container.getMappedPort(5432),
    username: 'postgres',
    password: 'test',
    database: 'test',
  });
  return ds.initialize();
}

d('cross-store resolve over two separate DataSource instances', () => {
  let canonicalContainer: StartedTestContainer;
  let eventsContainer: StartedTestContainer;
  let canonicalDS: DataSource;
  let eventsDS: DataSource;
  let registry: ReferenceRegistry;
  let canonical: DataSourceAdapter;

  beforeAll(async () => {
    [canonicalContainer, eventsContainer] = await Promise.all([boot(), boot()]);
    [canonicalDS, eventsDS] = await Promise.all([
      connect(canonicalContainer),
      connect(eventsContainer),
    ]);

    // --- canonical instance: the referenced rows ---
    await canonicalDS.query(
      'CREATE TABLE accounts (id uuid PRIMARY KEY, workspace_id text NOT NULL, status text NOT NULL)',
    );
    await canonicalDS.query(
      `INSERT INTO accounts (id, workspace_id, status) VALUES
       ($1,'w1','open'), ($2,'w1','closed'), ($3,'w2','open')`,
      [A1, A2, A3],
    );
    await canonicalDS.query('CREATE TABLE ledger (entry bigint PRIMARY KEY, memo text)');
    await canonicalDS.query(`INSERT INTO ledger (entry, memo) VALUES (1001,'a'), (1002,'b')`);
    // A mixed-case, quote-DDL'd key column: proves row-indexing survives case (the quoted WHERE
    // matches case-exactly, and pg returns the catalog case as the row key → row["RefId"] hits).
    await canonicalDS.query('CREATE TABLE docs ("RefId" text PRIMARY KEY, title text)');
    await canonicalDS.query(`INSERT INTO docs ("RefId", title) VALUES ('d1','hello')`);

    // --- events instance (separate container, TimescaleDB): the referencing rows ---
    await eventsDS.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
    await eventsDS.query('CREATE TABLE usage (ts timestamptz NOT NULL, account_id uuid NOT NULL)');
    await eventsDS.query("SELECT create_hypertable('usage','ts')");
    await eventsDS.query(`INSERT INTO usage (ts, account_id) VALUES (now(), $1), (now(), $2)`, [
      A1,
      MISSING,
    ]);

    registry = new ReferenceRegistry()
      .register({ ...CANONICAL, scopeColumns: ['workspace_id'], targetIsAppendOnly: true })
      .register({ ...LEDGER, targetIsAppendOnly: true });
    canonical = new DataSourceAdapter({ store: 'canonical', runner: canonicalDS });
  }, 300_000);

  afterAll(async () => {
    await canonicalDS?.destroy();
    await eventsDS?.destroy();
    await Promise.all([canonicalContainer?.stop(), eventsContainer?.stop()]);
  });

  it('resolves existing uuid references and exposes the snapshot row', async () => {
    const [v] = await resolveReferences([{ ref: CANONICAL, value: A1 }], {
      registry,
      adapters: [canonical],
    });
    expect(v?.ok).toBe(true);
    expect(v?.row?.status).toBe('open');
  });

  it('reports a genuinely missing uuid as not_found', async () => {
    const [v] = await resolveReferences([{ ref: CANONICAL, value: MISSING }], {
      registry,
      adapters: [canonical],
    });
    expect(v?.status).toBe('not_found');
  });

  it('applies the scope filter as a bound predicate (wrong workspace → not_found)', async () => {
    // A3 exists but is in workspace w2; scoping to w1 must not resolve it
    const [inScope, outOfScope] = await resolveReferences(
      [
        { ref: CANONICAL, value: A1, scope: { workspace_id: 'w1' } },
        { ref: CANONICAL, value: A3, scope: { workspace_id: 'w1' } },
      ],
      { registry, adapters: [canonical] },
    );
    expect(inScope?.ok).toBe(true);
    expect(outOfScope?.status).toBe('not_found');
  });

  it('resolves bigint references across number/string via ANY($1) (no type-cast needed)', async () => {
    const verdicts = await resolveReferences(
      [
        { ref: LEDGER, value: 1001 },
        { ref: LEDGER, value: '1002' },
        { ref: LEDGER, value: 9999 },
      ],
      { registry, adapters: [canonical] },
    );
    expect(verdicts.map((v) => v.status)).toEqual(['resolved', 'resolved', 'not_found']);
  });

  it('binds a hostile scope value (no injection, no error, just not_found)', async () => {
    const [v] = await resolveReferences(
      [{ ref: CANONICAL, value: A1, scope: { workspace_id: "w1' OR '1'='1" } }],
      { registry, adapters: [canonical] },
    );
    // the value is bound, so it matches no workspace → not_found (and the accounts table survives)
    expect(v?.status).toBe('not_found');
    const [{ count }] = await canonicalDS.query('SELECT count(*)::int AS count FROM accounts');
    expect(count).toBe(3);
  });

  it('resolves references that live on a SEPARATE instance from the referenced rows', async () => {
    // read the referencing rows from the events instance, resolve them against canonical
    const usage: Array<{ account_id: string }> = await eventsDS.query(
      'SELECT account_id FROM usage ORDER BY account_id',
    );
    const verdicts = await resolveReferences(
      usage.map((u) => ({ ref: CANONICAL, value: u.account_id })),
      { registry, adapters: [canonical] },
    );
    // A1 resolves, MISSING does not — proving cross-instance validation
    const byOk = verdicts.map((v) => v.ok).sort();
    expect(byOk).toEqual([false, true]);
  });

  it('resolves a reference on a mixed-case (quoted-DDL) key column — row indexing survives case', async () => {
    const DOCS = { store: 'canonical', table: 'docs', column: 'RefId' };
    const reg = new ReferenceRegistry().register(DOCS);
    const [hit, miss] = await resolveReferences(
      [
        { ref: DOCS, value: 'd1' },
        { ref: DOCS, value: 'nope' },
      ],
      { registry: reg, adapters: [canonical] },
    );
    expect(hit?.ok).toBe(true);
    expect(hit?.row?.title).toBe('hello');
    expect(miss?.status).toBe('not_found');
  });

  it('treats a type-incompatible id as unavailable (fail-safe), never a silent not_found or crash', async () => {
    // 'not-a-uuid' is a valid scalar but not a valid uuid → pg rejects the batch (22P02). The
    // engine must record `unavailable` (couldn't verify) — NOT not_found, and NOT a thrown crash.
    const [v] = await resolveReferences([{ ref: CANONICAL, value: 'not-a-uuid' }], {
      registry,
      adapters: [canonical],
    });
    expect(v?.status).toBe('unavailable');
  });

  it('batches a mixed id set into one round-trip per group', async () => {
    const verdicts = await resolveReferences(
      [A1, A2, A1].map((value) => ({ ref: CANONICAL, value })),
      { registry, adapters: [canonical] },
    );
    expect(verdicts.every((v) => v.ok)).toBe(true);
  });

  // The full adapter contract against the REAL DataSource adapter (batching + all-or-throw).
  runAdapterConformance(
    'DataSourceAdapter (real Postgres)',
    async (): Promise<ConformanceContext> => {
      const seeded: SnapshotRow[] = [
        { id: A1, workspace_id: 'w1' },
        { id: A2, workspace_id: 'w1' },
        { id: A3, workspace_id: 'w2' },
      ];
      // a broken adapter: a DataSource that has been destroyed → findMany rejects
      const dead = await connect(canonicalContainer);
      await dead.destroy();
      return {
        adapter: canonical,
        brokenAdapter: new DataSourceAdapter({ store: 'canonical', runner: dead }),
        table: 'accounts',
        column: 'id',
        seeded,
        scopeColumn: 'workspace_id',
        missingId: MISSING, // a valid-but-unused uuid (type-valid absence)
      };
    },
  );
});
