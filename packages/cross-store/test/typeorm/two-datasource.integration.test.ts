import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import {
  ReferenceRegistry,
  resolveReferences,
  CrossStoreErrorCode,
  type ReferenceCheck,
} from '../../src/index.js';
import { DataSourceAdapter } from '../../src/typeorm/data-source-adapter.js';

/**
 * The end-to-end proof for M3.3a: cross-store reference resolution across TWO SEPARATE
 * database instances (not two schemas on one server) — a plain-Postgres "canonical" store and
 * a TimescaleDB "events" store, each its own container, each its own `DataSource`, each its own
 * `DataSourceAdapter`. `resolveReferences` never knows they are different servers; that is
 * exactly the property this package exists to make safe (app-level validation, no FDW/dblink).
 *
 * Skips (like the package's other integration tests) unless `TIMESCALE_IMAGE` is set — CI sets
 * it per the version matrix; a plain local run without Docker self-skips.
 */
const TIMESCALE_IMAGE = process.env.TIMESCALE_IMAGE;
const POSTGRES_IMAGE = process.env.POSTGRES_IMAGE ?? 'postgres:17-alpine';

describe.skipIf(!TIMESCALE_IMAGE)('cross-store resolution across two real DataSources', () => {
  let canonicalContainer: StartedTestContainer;
  let eventsContainer: StartedTestContainer;
  let canonical: DataSource;
  let events: DataSource;

  beforeAll(async () => {
    [canonicalContainer, eventsContainer] = await Promise.all([
      new GenericContainer(POSTGRES_IMAGE)
        .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'test' })
        .withExposedPorts(5432)
        .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
        .start(),
      new GenericContainer(TIMESCALE_IMAGE as string)
        .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'test' })
        .withExposedPorts(5432)
        .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
        .start(),
    ]);

    canonical = new DataSource({
      type: 'postgres',
      host: canonicalContainer.getHost(),
      port: canonicalContainer.getMappedPort(5432),
      username: 'postgres',
      password: 'test',
      database: 'test',
    });
    events = new DataSource({
      type: 'postgres',
      host: eventsContainer.getHost(),
      port: eventsContainer.getMappedPort(5432),
      username: 'postgres',
      password: 'test',
      database: 'test',
    });
    await Promise.all([canonical.initialize(), events.initialize()]);
    await events.query('CREATE EXTENSION IF NOT EXISTS timescaledb');

    // canonical store: two tables to exercise text AND uuid id columns.
    await canonical.query(`
      CREATE TABLE canonical_records (
        id text PRIMARY KEY,
        workspace_id text NOT NULL
      )
    `);
    await canonical.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    await canonical.query(`
      CREATE TABLE canonical_accounts (
        id uuid PRIMARY KEY,
        workspace_id text NOT NULL
      )
    `);

    // events store (TimescaleDB): bigint id column.
    await events.query(`
      CREATE TABLE events (
        id bigint PRIMARY KEY,
        workspace_id text NOT NULL,
        recorded_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }, 180_000);

  afterAll(async () => {
    await canonical?.destroy();
    await events?.destroy();
    await canonicalContainer?.stop();
    await eventsContainer?.stop();
  });

  const RECORDS_REF = { store: 'canonical', table: 'canonical_records', column: 'id' };
  const ACCOUNTS_REF = { store: 'canonical', table: 'canonical_accounts', column: 'id' };
  const EVENTS_REF = { store: 'events', table: 'events', column: 'id' };

  const UUID_1 = '11111111-1111-4111-8111-111111111111';
  const UUID_2 = '22222222-2222-4222-8222-222222222222';
  const HOSTILE_WORKSPACE = "w2' OR '1'='1";

  function registry(): ReferenceRegistry {
    return new ReferenceRegistry()
      .register({ ...RECORDS_REF, scopeColumns: ['workspace_id'], targetIsAppendOnly: true })
      .register({ ...ACCOUNTS_REF, scopeColumns: ['workspace_id'], targetIsAppendOnly: true })
      .register({ ...EVENTS_REF, scopeColumns: ['workspace_id'], targetIsAppendOnly: true });
  }

  function adapters(): DataSourceAdapter[] {
    return [
      new DataSourceAdapter({ store: 'canonical', dataSource: canonical }),
      new DataSourceAdapter({ store: 'events', dataSource: events }),
    ];
  }

  beforeAll(async () => {
    await canonical.query(
      `INSERT INTO canonical_records (id, workspace_id) VALUES
         ('rec-safe-1', 'w1'),
         ('rec-safe-2', $1)`,
      [HOSTILE_WORKSPACE],
    );
    await canonical.query(`INSERT INTO canonical_accounts (id, workspace_id) VALUES ($1, 'w1')`, [
      UUID_1,
    ]);
    await events.query(
      `INSERT INTO events (id, workspace_id) VALUES (9007199254740993, 'w1')`, // > Number.MAX_SAFE_INTEGER
    );
  });

  it('resolves a happy reference in the canonical (text id) store', async () => {
    const [verdict] = await resolveReferences(
      [{ ref: RECORDS_REF, value: 'rec-safe-1', scope: { workspace_id: 'w1' } }],
      { registry: registry(), adapters: adapters() },
    );
    expect(verdict?.ok).toBe(true);
    expect(verdict?.status).toBe('resolved');
    expect(verdict?.row?.workspace_id).toBe('w1');
  });

  it('resolves a happy reference in the canonical (uuid id) store', async () => {
    const [verdict] = await resolveReferences(
      [{ ref: ACCOUNTS_REF, value: UUID_1, scope: { workspace_id: 'w1' } }],
      { registry: registry(), adapters: adapters() },
    );
    expect(verdict?.ok).toBe(true);
    expect(verdict?.row?.id).toBe(UUID_1);
  });

  it('resolves a happy reference in the events (TimescaleDB, bigint id) store across the SEPARATE instance', async () => {
    const [verdict] = await resolveReferences(
      [{ ref: EVENTS_REF, value: '9007199254740993', scope: { workspace_id: 'w1' } }],
      { registry: registry(), adapters: adapters() },
    );
    expect(verdict?.ok).toBe(true);
    expect(verdict?.status).toBe('resolved');
  });

  it('reports a genuinely absent reference as not_found', async () => {
    const [verdict] = await resolveReferences(
      [{ ref: RECORDS_REF, value: 'does-not-exist', scope: { workspace_id: 'w1' } }],
      { registry: registry(), adapters: adapters() },
    );
    expect(verdict?.ok).toBe(false);
    expect(verdict?.status).toBe('not_found');
    expect(verdict?.error?.code).toBe(CrossStoreErrorCode.REFERENCE_NOT_FOUND);
  });

  it('reports a never-seeded uuid id as not_found (uuid id type)', async () => {
    const [verdict] = await resolveReferences(
      [{ ref: ACCOUNTS_REF, value: UUID_2, scope: { workspace_id: 'w1' } }],
      { registry: registry(), adapters: adapters() },
    );
    expect(verdict?.status).toBe('not_found');
  });

  it('a wrong scope value does not resolve a row that exists under a different workspace', async () => {
    const [verdict] = await resolveReferences(
      [{ ref: RECORDS_REF, value: 'rec-safe-1', scope: { workspace_id: 'wrong-workspace' } }],
      { registry: registry(), adapters: adapters() },
    );
    expect(verdict?.status).toBe('not_found');
  });

  it('binds a hostile scope value as a literal — exact match resolves normally', async () => {
    const [verdict] = await resolveReferences(
      [{ ref: RECORDS_REF, value: 'rec-safe-2', scope: { workspace_id: HOSTILE_WORKSPACE } }],
      { registry: registry(), adapters: adapters() },
    );
    expect(verdict?.ok).toBe(true);
    expect(verdict?.row?.workspace_id).toBe(HOSTILE_WORKSPACE);
  });

  it("proves the hostile scope value is bound, not interpolated: it cannot bypass another row's real scope", async () => {
    // If `workspace_id = $2` were built by string concatenation instead of binding, a scope
    // value like `w2' OR '1'='1` would turn the clause into an always-true predicate and
    // "resolve" rec-safe-1 (whose real workspace is 'w1') regardless of the scope requested.
    // With a bound parameter it is compared as one opaque string and must NOT match.
    const [verdict] = await resolveReferences(
      [{ ref: RECORDS_REF, value: 'rec-safe-1', scope: { workspace_id: HOSTILE_WORKSPACE } }],
      { registry: registry(), adapters: adapters() },
    );
    expect(verdict?.ok).toBe(false);
    expect(verdict?.status).toBe('not_found');
  });

  it('resolves a batch spanning both instances in one pass, preserving input order', async () => {
    const checks: ReferenceCheck[] = [
      { ref: RECORDS_REF, value: 'rec-safe-1', scope: { workspace_id: 'w1' } },
      { ref: EVENTS_REF, value: '9007199254740993', scope: { workspace_id: 'w1' } },
      { ref: RECORDS_REF, value: 'does-not-exist', scope: { workspace_id: 'w1' } },
      { ref: ACCOUNTS_REF, value: UUID_1, scope: { workspace_id: 'w1' } },
    ];
    const verdicts = await resolveReferences(checks, {
      registry: registry(),
      adapters: adapters(),
    });
    expect(verdicts.map((v) => v.status)).toEqual([
      'resolved',
      'resolved',
      'not_found',
      'resolved',
    ]);
  });

  it('surfaces ADAPTER_UNAVAILABLE (not a false not_found) when a store instance is unreachable', async () => {
    // A DataSource that was never initialize()'d rejects any .query() — the same shape of
    // failure a real connection drop produces (an adapter MAY throw for any reason; the engine
    // must map it to unavailable, never a false not_found).
    const uninitialized = new DataSource({
      type: 'postgres',
      host: canonicalContainer.getHost(),
      port: canonicalContainer.getMappedPort(5432),
      username: 'postgres',
      password: 'test',
      database: 'test',
    });
    const brokenAdapter = new DataSourceAdapter({ store: 'canonical', dataSource: uninitialized });
    const [verdict] = await resolveReferences(
      [{ ref: RECORDS_REF, value: 'rec-safe-1', scope: { workspace_id: 'w1' } }],
      {
        registry: registry(),
        adapters: [brokenAdapter, new DataSourceAdapter({ store: 'events', dataSource: events })],
      },
    );
    expect(verdict?.ok).toBe(false);
    expect(verdict?.status).toBe('unavailable');
    expect(verdict?.error?.code).toBe(CrossStoreErrorCode.ADAPTER_UNAVAILABLE);
  }, 20_000);
});
