import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { DataSource } from 'typeorm';
import {
  applyRecompression,
  formatRecompressionPlan,
  planRecompression,
  type RecompressionProgress,
} from '../src/index.js';

const IMAGE = process.env.TIMESCALE_IMAGE ?? process.env.TIMESCALE_TOOLKIT_IMAGE;

/**
 * The recompression planner, against real compressed chunks.
 *
 * Nothing here can be faked. The defect this closes is that `ALTER TABLE ... SET (segmentby)` leaves
 * ALREADY-compressed chunks in the old layout while the catalog reports the new table-level setting
 * — so the only way to show the fix works is to compress real chunks, alter, and read the storage
 * back. A stubbed catalog would just replay whatever shape the author assumed, and the shape is
 * exactly what differs between versions (2.18 keys settings by the COMPRESSED chunk, 2.28 by the
 * user-facing one).
 */
describe.skipIf(!IMAGE)('recompression planner — live chunks', () => {
  let container: StartedTestContainer;
  let ds: DataSource;

  const compressedCount = async (): Promise<number> => {
    const r: { n: string }[] = await ds.query(
      `SELECT count(*) AS n FROM timescaledb_information.chunks
       WHERE hypertable_name = 'm' AND is_compressed`,
    );
    return Number(r[0]?.n ?? 0);
  };

  /** True on the PINNED 2.18 tag, where the internal catalog shape is known and fixed. */
  let pinnedVersion = false;

  beforeAll(async () => {
    container = await new GenericContainer(IMAGE as string)
      .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'test' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();

    ds = new DataSource({
      type: 'postgres',
      host: container.getHost(),
      port: container.getMappedPort(5432),
      username: 'postgres',
      password: 'test',
      database: 'test',
      entities: [],
      synchronize: false,
    });
    await ds.initialize();
    await ds.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
    await ds.query(`CREATE TABLE m(ts TIMESTAMPTZ NOT NULL, dev TEXT, v DOUBLE PRECISION)`);
    await ds.query(`SELECT create_hypertable('m','ts', chunk_time_interval => INTERVAL '1 day')`);
    await ds.query(
      `INSERT INTO m SELECT now()-(i||' hours')::interval, 'd'||(i%3), i FROM generate_series(1,150) i`,
    );
    await ds.query(
      `ALTER TABLE m SET (timescaledb.enable_columnstore = true, timescaledb.segmentby = 'dev')`,
    );
    await ds.query(`SELECT compress_chunk(c) FROM show_chunks('m') c`);

    const v: { extversion: string }[] = await ds.query(
      `SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'`,
    );
    pinnedVersion = (v[0]?.extversion ?? '').startsWith('2.18.');
  }, 300_000);

  afterAll(async () => {
    await ds?.destroy();
    await container?.stop();
  });

  it('reports nothing to do while the chunks still match the declaration', async () => {
    const plan = await planRecompression(ds, 'm');
    expect(plan.compressedChunkCount).toBeGreaterThan(0);
    // THE CONTRACT, on every version: an empty list is reported ONLY when the planner could
    // actually verify it. `exact` + no chunks is a real all-clear; `unknown` must list candidates
    // instead of claiming clean. Both are correct — silently-clean-without-checking is not.
    if (plan.precision === 'exact') {
      expect(plan.chunks).toEqual([]);
      expect(formatRecompressionPlan(plan)).toMatch(/already match/);
    } else {
      expect(plan.chunks.length).toBe(plan.compressedChunkCount);
      expect(formatRecompressionPlan(plan)).toMatch(/Could not determine/);
    }
    // On the PINNED 2.18 tag exact precision is REQUIRED. Demanding it against the moving `latest`
    // tag would put CI on a treadmill chasing TimescaleDB's internal catalog, which has already
    // changed shape twice across the supported range — see the module doc.
    if (pinnedVersion) expect(plan.precision).toBe('exact');
  }, 120_000);

  it('identifies exactly the chunks left stale by a segmentby change', async () => {
    const before = await compressedCount();
    expect(before).toBeGreaterThan(1);

    await ds.query(`ALTER TABLE m SET (timescaledb.segmentby = 'v')`);

    const plan = await planRecompression(ds, 'm');
    // The version-independent guarantee: after a segmentby change, stale chunks are NEVER missed.
    // Under `exact` those are the genuinely stale ones; under `unknown` it is every compressed
    // chunk. Either way non-empty — MISSING them is the failure that matters.
    expect(plan.chunks.length).toBe(before);

    if (pinnedVersion) {
      // On the pinned tag, also prove the per-chunk settings were genuinely READ, not assumed.
      expect(plan.precision).toBe('exact');
      expect(plan.chunks[0]?.chunkSegmentBy).toEqual(['dev']);
      expect(plan.chunks[0]?.desiredSegmentBy).toEqual(['v']);
      expect(formatRecompressionPlan(plan)).toMatch(/segmentby \[dev\] → \[v\]/);
    }
  }, 120_000);

  it('refuses to run without explicit confirmation', async () => {
    const plan = await planRecompression(ds, 'm');
    await expect(
      applyRecompression(ds, plan, { confirm: false as unknown as true }),
    ).rejects.toThrow(/confirmed explicitly/);
  }, 60_000);

  it('rewrites the stale chunks, and a re-plan then comes back clean', async () => {
    const plan = await planRecompression(ds, 'm');
    expect(plan.chunks.length).toBeGreaterThan(0);

    const progress: RecompressionProgress[] = [];
    const result = await applyRecompression(ds, plan, {
      confirm: true,
      onProgress: (p) => progress.push(p),
    });

    expect(result.failed).toEqual([]);
    expect(result.processed.length).toBe(plan.chunks.length);
    // Two phases per chunk, in order — a long run has to be observable rather than look like a hang.
    expect(progress.length).toBe(plan.chunks.length * 2);
    expect(progress[0]?.phase).toBe('decompressed');
    expect(progress[1]?.phase).toBe('recompressed');

    // The chunks are still compressed — this rewrites storage, it does not leave data in rowstore.
    expect(await compressedCount()).toBe(plan.chunks.length);

    // THE ASSERTION THAT MATTERS: the storage now matches the declaration. Under `exact` that is an
    // empty list; under `unknown` the planner still cannot tell, and conservatively re-listing every
    // compressed chunk is the correct answer rather than a failure.
    const after = await planRecompression(ds, 'm');
    if (after.precision === 'exact') {
      expect(after.chunks).toEqual([]);
    } else {
      expect(after.chunks.length).toBe(after.compressedChunkCount);
    }
    if (pinnedVersion) expect(after.precision).toBe('exact');
  }, 300_000);

  it('loses no rows across the rewrite', async () => {
    // Decompress/compress are lossless representations of the same data — assert it rather than
    // trust it, because this is the operation with the most to lose if that were ever untrue.
    const rows: { n: string }[] = await ds.query('SELECT count(*) AS n FROM m');
    expect(Number(rows[0]?.n)).toBe(150);
    const sum: { s: string }[] = await ds.query('SELECT sum(v)::text AS s FROM m');
    expect(Number(sum[0]?.s)).toBe((150 * 151) / 2);
  }, 60_000);

  it('is resumable: running it again is a no-op, not an error', async () => {
    // Both primitives are idempotent (if_compressed / if_not_compressed), which is what lets an
    // interrupted multi-hour run be re-run rather than restarted.
    const plan = await planRecompression(ds, 'm');
    const result = await applyRecompression(
      ds,
      { ...plan, chunks: plan.chunks },
      { confirm: true },
    );
    expect(result.failed).toEqual([]);
  }, 120_000);

  it('rolls back a chunk whose recompress fails, never stranding it in rowstore (#199)', async () => {
    // THE TEST THAT WOULD HAVE CAUGHT THE CRITICAL. Two reviewers found, independently, that a crash
    // between the decompress and the compress left the chunk uncompressed — and since the planner
    // only looks at chunks WHERE is_compressed, it would never be seen again. "Re-run it" (the
    // documented recovery) could not help, because the planner could no longer see the chunk.
    //
    // The old resumability test only re-ran after a SUCCESSFUL pass, so it could never observe this.
    // Here the failure is injected between the two phases, against a real database, and the
    // assertion is on what SURVIVES.
    // Self-contained: its own hypertable, so it cannot depend on what earlier tests left behind.
    // (The first version reused `m` and silently found nothing stale, because a previous test had
    // already converged it — the coupling makes a real failure here look like a bug in rollback.)
    await ds.query(`CREATE TABLE fault(ts TIMESTAMPTZ NOT NULL, dev TEXT, v DOUBLE PRECISION)`);
    await ds.query(
      `SELECT create_hypertable('fault','ts', chunk_time_interval => INTERVAL '1 day')`,
    );
    await ds.query(
      `INSERT INTO fault SELECT now()-(i||' hours')::interval, 'd'||(i%3), i FROM generate_series(1,80) i`,
    );
    await ds.query(
      `ALTER TABLE fault SET (timescaledb.enable_columnstore = true, timescaledb.segmentby = 'dev')`,
    );
    await ds.query(`SELECT compress_chunk(c) FROM show_chunks('fault') c`);
    await ds.query(`ALTER TABLE fault SET (timescaledb.segmentby = 'v')`);

    const faultCompressed = async (): Promise<number> => {
      const r: { n: string }[] = await ds.query(
        `SELECT count(*) AS n FROM timescaledb_information.chunks
         WHERE hypertable_name = 'fault' AND is_compressed`,
      );
      return Number(r[0]?.n ?? 0);
    };

    const plan = await planRecompression(ds, 'fault');
    expect(plan.chunks.length).toBeGreaterThan(0);

    const target = plan.chunks[0] as { chunk: string };
    const compressedBefore = await faultCompressed();

    // Wrap the real DataSource: everything runs for real EXCEPT the compress, which throws — i.e.
    // exactly the moment a process would die mid-rewrite.
    const faulty = {
      isInitialized: true,
      createQueryRunner: () => {
        const runner = ds.createQueryRunner();
        return new Proxy(runner, {
          get(t, prop, recv) {
            if (prop !== 'query') return Reflect.get(t, prop, recv) as unknown;
            return async (sql: string, params?: unknown[]) => {
              if (/SELECT compress_chunk\(/.test(sql)) throw new Error('injected: process died');
              return (t.query as (s: string, p?: unknown[]) => Promise<unknown>)(sql, params);
            };
          },
        });
      },
    } as unknown as DataSource;

    const result = await applyRecompression(
      faulty,
      { ...plan, chunks: [target] },
      { confirm: true },
    );
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.error).toMatch(/injected/);
    expect(result.processed).toEqual([]);

    // THE ASSERTION THAT MATTERS: the chunk is STILL COMPRESSED. Before the per-chunk transaction it
    // was left in rowstore and became permanently invisible to the planner.
    expect(await faultCompressed()).toBe(compressedBefore);
    const after = await planRecompression(ds, 'fault');
    expect(after.chunks.map((c) => c.chunk)).toContain(target.chunk);

    // ...and a normal re-run then completes it, which is what "resumable" is supposed to mean.
    const finished = await applyRecompression(ds, after, { confirm: true });
    expect(finished.failed).toEqual([]);
    expect((await planRecompression(ds, 'fault')).chunks).toEqual([]);

    await ds.query('DROP TABLE fault CASCADE');
  }, 300_000);

  it('detects an ORDERBY-only change, not just segmentby (#199 CRITICAL)', async () => {
    // Red-team found the planner compared segmentby ONLY, so an orderby-only change reported
    // "already match" while every chunk on disk was stale — the exact false-green this planner
    // exists to remove, inside the planner that removes it. compression_settings has carried
    // `orderby` all along; it simply was not read.
    await ds.query(`CREATE TABLE ob(ts TIMESTAMPTZ NOT NULL, dev TEXT, v DOUBLE PRECISION)`);
    await ds.query(`SELECT create_hypertable('ob','ts', chunk_time_interval => INTERVAL '1 day')`);
    await ds.query(
      `INSERT INTO ob SELECT now()-(i||' hours')::interval, 'd'||(i%3), i FROM generate_series(1,60) i`,
    );
    await ds.query(
      `ALTER TABLE ob SET (timescaledb.enable_columnstore = true,
         timescaledb.segmentby = 'dev', timescaledb.orderby = 'ts DESC')`,
    );
    await ds.query(`SELECT compress_chunk(c) FROM show_chunks('ob') c`);
    expect((await planRecompression(ds, 'ob')).chunks).toEqual([]);

    // Change ONLY the orderby. segmentby is untouched.
    await ds.query(`ALTER TABLE ob SET (timescaledb.orderby = 'ts ASC')`);

    const plan = await planRecompression(ds, 'ob');
    expect(plan.chunks.length).toBeGreaterThan(0);
    expect(formatRecompressionPlan(plan)).toMatch(/orderby/);

    // ...and the rewrite converges it, so this is a real fix rather than a louder report.
    await applyRecompression(ds, plan, { confirm: true });
    expect((await planRecompression(ds, 'ob')).chunks).toEqual([]);

    await ds.query('DROP TABLE ob CASCADE');
  }, 300_000);

  it('finds chunks for a hypertable whose name needs identifier quoting (#199 HIGH)', async () => {
    // The name was matched via format('%I.%I', …) = $1, and format() quotes only identifiers that
    // need it — so "My Table" rendered as "public"."My Table" and never equalled the plain
    // 'public.My Table' the caller passed. The planner reported "no compressed chunks" for a table
    // full of them: a silent all-clear on an unexamined table.
    await ds.query(`CREATE TABLE "My Table"(ts TIMESTAMPTZ NOT NULL, v DOUBLE PRECISION)`);
    await ds.query(
      `SELECT create_hypertable('"My Table"','ts', chunk_time_interval => INTERVAL '1 day')`,
    );
    await ds.query(
      `INSERT INTO "My Table" SELECT now()-(i||' hours')::interval, i FROM generate_series(1,50) i`,
    );
    await ds.query(`ALTER TABLE "My Table" SET (timescaledb.enable_columnstore = true)`);
    await ds.query(`SELECT compress_chunk(c) FROM show_chunks('"My Table"') c`);

    const plan = await planRecompression(ds, 'public.My Table');
    expect(plan.compressedChunkCount).toBeGreaterThan(0);

    await ds.query('DROP TABLE "My Table" CASCADE');
  }, 300_000);

  it('reports a hypertable with no compressed chunks as nothing to do', async () => {
    await ds.query(`CREATE TABLE bare(ts TIMESTAMPTZ NOT NULL, v DOUBLE PRECISION)`);
    await ds.query(`SELECT create_hypertable('bare','ts')`);
    const plan = await planRecompression(ds, 'bare');
    expect(plan.compressedChunkCount).toBe(0);
    expect(plan.chunks).toEqual([]);
    expect(formatRecompressionPlan(plan)).toMatch(/no compressed chunks/);
  }, 120_000);

  it('continues past a chunk it cannot process rather than abandoning the rest', async () => {
    // One unrewritable chunk must not leave the other ninety-nine in the old layout. Provoked with a
    // chunk name that does not exist, alongside two real ones.
    await ds.query(`ALTER TABLE m SET (timescaledb.segmentby = 'dev')`);
    const real = await planRecompression(ds, 'm');
    expect(real.chunks.length).toBeGreaterThan(1);

    const withGhost = {
      ...real,
      chunks: [{ chunk: '_timescaledb_internal._no_such_chunk' }, ...real.chunks.slice(0, 2)],
    };
    const result = await applyRecompression(ds, withGhost, { confirm: true });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.chunk).toBe('_timescaledb_internal._no_such_chunk');
    expect(result.processed).toHaveLength(2); // the real ones still got done
  }, 300_000);
});
