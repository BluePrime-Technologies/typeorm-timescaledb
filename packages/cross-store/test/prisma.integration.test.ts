import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { ReferenceRegistry, resolveReferences, type SnapshotRow } from '../src/index.js';
import { PrismaAdapter, type PrismaClientLike } from '../src/prisma.js';
import { runAdapterConformance, type ConformanceContext } from './conformance.js';

/**
 * M3.3b — the Prisma adapter against a REAL Prisma client + Postgres. Proves the type-strict
 * binding workaround (`col::text = ANY($1)` with string params) actually resolves uuid / bigint /
 * text / mixed-case keys, and that `@prisma/client` is only touched here (dynamic import, so the
 * file loads even when the client isn't generated). Skips unless TIMESCALE_IMAGE is set.
 */
const IMAGE = process.env.TIMESCALE_IMAGE;
const d = IMAGE ? describe : describe.skip;

/** The bit of a real PrismaClient this test drives (superset of the adapter's PrismaClientLike). */
interface TestPrisma extends PrismaClientLike {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $disconnect(): Promise<void>;
}

const A1 = '11111111-1111-1111-1111-111111111111';
const A2 = '22222222-2222-2222-2222-222222222222';
const A3 = '33333333-3333-3333-3333-333333333333'; // workspace w2
const A_ALPHA = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // has letters → case actually differs
const MISSING = '99999999-9999-9999-9999-999999999999';

const ACCOUNTS = { store: 'canonical', table: 'accounts', column: 'id' };
const LEDGER = { store: 'canonical', table: 'ledger', column: 'entry' };
const DOCS = { store: 'canonical', table: 'docs', column: 'RefId' };

d('cross-store resolve through a real Prisma adapter', () => {
  let container: StartedTestContainer;
  let prisma: TestPrisma;
  let registry: ReferenceRegistry;
  let adapter: PrismaAdapter;

  beforeAll(async () => {
    container = await new GenericContainer(IMAGE as string)
      .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'test' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
    const url = `postgresql://postgres:test@${container.getHost()}:${container.getMappedPort(5432)}/test`;

    // Dynamic import so a missing generated client doesn't break module load (the describe is
    // env-gated; CI runs `prisma generate` before this).
    const { PrismaClient } = (await import('@prisma/client')) as unknown as {
      PrismaClient: new (opts: { datasources: { db: { url: string } } }) => TestPrisma;
    };
    prisma = new PrismaClient({ datasources: { db: { url } } });

    await prisma.$executeRawUnsafe(
      'CREATE TABLE accounts (id uuid PRIMARY KEY, workspace_id text NOT NULL, status text NOT NULL)',
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO accounts (id, workspace_id, status) VALUES
       ('${A1}','w1','open'), ('${A2}','w1','closed'), ('${A3}','w2','open'), ('${A_ALPHA}','w1','open')`,
    );
    await prisma.$executeRawUnsafe('CREATE TABLE ledger (entry bigint PRIMARY KEY, memo text)');
    await prisma.$executeRawUnsafe(
      `INSERT INTO ledger (entry, memo) VALUES (1001,'a'), (1002,'b')`,
    );
    await prisma.$executeRawUnsafe('CREATE TABLE docs ("RefId" text PRIMARY KEY, title text)');
    await prisma.$executeRawUnsafe(`INSERT INTO docs ("RefId", title) VALUES ('d1','hello')`);

    registry = new ReferenceRegistry()
      .register({ ...ACCOUNTS, scopeColumns: ['workspace_id'], targetIsAppendOnly: true })
      .register({ ...LEDGER, targetIsAppendOnly: true })
      .register({ ...DOCS });
    adapter = new PrismaAdapter({ store: 'canonical', client: prisma });
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  it('resolves a uuid reference (type-strict binding via col::text) and exposes the row', async () => {
    const [v] = await resolveReferences([{ ref: ACCOUNTS, value: A1 }], {
      registry,
      adapters: [adapter],
    });
    expect(v?.ok).toBe(true);
    expect(v?.row?.status).toBe('open');
  });

  it('reports a missing uuid as not_found', async () => {
    const [v] = await resolveReferences([{ ref: ACCOUNTS, value: MISSING }], {
      registry,
      adapters: [adapter],
    });
    expect(v?.status).toBe('not_found');
  });

  it('resolves a uuid target declared with columnType via the param-cast ($1::uuid[]) under Prisma', async () => {
    // the point of columnType: keep the target's index (bare column) while Prisma binds type-strictly.
    // native `uuid = ANY($1)` fails under Prisma (P2010); the param-cast `= ANY($1::uuid[])` works.
    const reg = new ReferenceRegistry().register({ ...ACCOUNTS, columnType: 'uuid' });
    const [hit, miss] = await resolveReferences(
      [
        { ref: ACCOUNTS, value: A1 },
        { ref: ACCOUNTS, value: MISSING },
      ],
      { registry: reg, adapters: [adapter] },
    );
    expect(hit?.ok).toBe(true);
    expect(hit?.row?.status).toBe('open');
    expect(miss?.status).toBe('not_found');
  });

  it('applies the scope filter (wrong workspace → not_found)', async () => {
    const [inScope, outOfScope] = await resolveReferences(
      [
        { ref: ACCOUNTS, value: A1, scope: { workspace_id: 'w1' } },
        { ref: ACCOUNTS, value: A3, scope: { workspace_id: 'w1' } },
      ],
      { registry, adapters: [adapter] },
    );
    expect(inScope?.ok).toBe(true);
    expect(outOfScope?.status).toBe('not_found');
  });

  it('resolves bigint references across number/string', async () => {
    const verdicts = await resolveReferences(
      [
        { ref: LEDGER, value: 1001 },
        { ref: LEDGER, value: '1002' },
        { ref: LEDGER, value: 9999 },
      ],
      { registry, adapters: [adapter] },
    );
    expect(verdicts.map((v) => v.status)).toEqual(['resolved', 'resolved', 'not_found']);
  });

  it('resolves a mixed-case (quoted-DDL) key column', async () => {
    const [hit, miss] = await resolveReferences(
      [
        { ref: DOCS, value: 'd1' },
        { ref: DOCS, value: 'nope' },
      ],
      { registry, adapters: [adapter] },
    );
    expect(hit?.ok).toBe(true);
    expect(hit?.row?.title).toBe('hello');
    expect(miss?.status).toBe('not_found');
  });

  it('an UPPERCASE (non-canonical) uuid resolves to not_found — consistent with String() equality', async () => {
    // `uuid::text` is canonical lowercase, and the resolver compares by String(value), so a
    // non-canonical (uppercase) input does not match — the SAME verdict the native TypeORM adapter
    // gives (its engine-side match is also String()-keyed on pg's lowercase render). Documented on
    // ReferenceCheck.value; asserted here so a future change can't silently make the adapters
    // disagree. Callers must pass values in the store's canonical form (drivers already do).
    // sanity: the lowercase form DOES resolve (proves the row exists), the uppercase does not
    const [lower] = await resolveReferences([{ ref: ACCOUNTS, value: A_ALPHA }], {
      registry,
      adapters: [adapter],
    });
    const [upper] = await resolveReferences([{ ref: ACCOUNTS, value: A_ALPHA.toUpperCase() }], {
      registry,
      adapters: [adapter],
    });
    expect(lower?.ok).toBe(true);
    expect(upper?.status).toBe('not_found');
  });

  it('binds a hostile scope value (no injection, table survives)', async () => {
    const [v] = await resolveReferences(
      [{ ref: ACCOUNTS, value: A1, scope: { workspace_id: "w1' OR '1'='1" } }],
      { registry, adapters: [adapter] },
    );
    expect(v?.status).toBe('not_found');
    const rows = (await prisma.$queryRawUnsafe(
      'SELECT count(*)::int AS count FROM accounts',
    )) as Array<{ count: number }>;
    expect(rows[0]?.count).toBe(4);
  });

  runAdapterConformance('PrismaAdapter (real Prisma)', (): Promise<ConformanceContext> => {
    const seeded: SnapshotRow[] = [
      { id: A1, workspace_id: 'w1' },
      { id: A2, workspace_id: 'w1' },
      { id: A3, workspace_id: 'w2' },
    ];
    return Promise.resolve({
      adapter,
      // a broken adapter: a client pointed at a closed connection
      brokenAdapter: new PrismaAdapter({
        store: 'canonical',
        client: {
          $queryRawUnsafe: () => Promise.reject(new Error('connection closed')),
        },
      }),
      table: 'accounts',
      column: 'id',
      seeded,
      scopeColumn: 'workspace_id',
      missingId: MISSING,
    });
  });
});
