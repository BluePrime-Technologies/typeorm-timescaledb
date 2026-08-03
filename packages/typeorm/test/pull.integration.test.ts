import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { DataSource } from 'typeorm';
import { introspect, pullSchema } from '../src/index.js';

const IMAGE = process.env.TIMESCALE_IMAGE ?? process.env.TIMESCALE_TOOLKIT_IMAGE;

/**
 * M4.4b `pull` — the real round-trip.
 *
 * A string assertion on generated SQL proves very little about reproduction fidelity. The property
 * that matters is: pull a schema out of one database, apply the result to another, and the two
 * databases must introspect to the SAME `SchemaStateIR`. That is what this exercises.
 *
 * Note the deliberate step of creating the base table in the target by hand before applying. That
 * is not test scaffolding to work around a bug — it is `pull`'s documented boundary
 * (`PULL_BASE_DDL_CAVEAT`): the reproduced migration covers the TimescaleDB layer and assumes the
 * relational objects already exist. Encoding it here keeps the boundary honest and visible.
 *
 * Coverage of inexpressible shapes (unmanaged `add_job`, integer-time thresholds,
 * `created_before` variants, dependency cycles) is unit-tested exhaustively in
 * core/test/reproduce.test.ts against hand-built IRs, which is both faster and able to reach
 * shapes that are awkward to provoke in a live database.
 */
const BASE_DDL = `
  CREATE TABLE IF NOT EXISTS metrics (
    ts     TIMESTAMPTZ NOT NULL,
    device TEXT        NOT NULL,
    value  DOUBLE PRECISION
  );
`;

describe.skipIf(!IMAGE)('M4.4b pull — live round-trip', () => {
  let container: StartedTestContainer;
  let source: DataSource;
  let target: DataSource;

  const connect = async (database: string): Promise<DataSource> => {
    const ds = new DataSource({
      type: 'postgres',
      host: container.getHost(),
      port: container.getMappedPort(5432),
      username: 'postgres',
      password: 'test',
      database,
      entities: [],
      synchronize: false,
    });
    await ds.initialize();
    await ds.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
    return ds;
  };

  beforeAll(async () => {
    container = await new GenericContainer(IMAGE as string)
      .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'test' })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();

    // Two independent databases in one container: the schema we pull FROM and the empty one we
    // reproduce INTO. Using two databases (not two schemas) keeps `public`-qualified names
    // identical on both sides, so an IR comparison is meaningful rather than name-shifted.
    const bootstrap = await connect('test');
    await bootstrap.query('CREATE DATABASE reproduced');
    await bootstrap.destroy();

    source = await connect('test');
    target = await connect('reproduced');

    // ── build a schema in `source` by hand, as a brownfield database would be ────────────────
    await source.query(BASE_DDL);
    await source.query(
      "SELECT create_hypertable('metrics', 'ts', chunk_time_interval => INTERVAL '1 day')",
    );
    await source.query(
      "ALTER TABLE metrics SET (timescaledb.enable_columnstore = true, timescaledb.segmentby = 'device')",
    );
    await source.query("SELECT add_retention_policy('metrics', INTERVAL '90 days')");
    await source.query(`
      CREATE MATERIALIZED VIEW metrics_hourly
        WITH (timescaledb.continuous, timescaledb.materialized_only = FALSE) AS
        SELECT time_bucket('1 hour', ts) AS bucket, device, avg(value) AS avg_value
        FROM metrics GROUP BY 1, 2 WITH NO DATA
    `);
    await source.query(
      "SELECT add_continuous_aggregate_policy('metrics_hourly', start_offset => INTERVAL '1 month', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '30 minutes')",
    );
  }, 300_000);

  afterAll(async () => {
    await source?.destroy();
    await target?.destroy();
    await container?.stop();
  });

  it('reproduces the source schema into an empty database, yielding an identical IR', async () => {
    const { migration, coverage } = await pullSchema(source);

    expect(coverage.hypertablesFound).toBe(1);
    expect(coverage.continuousAggregatesFound).toBe(1);
    expect(migration.up.length).toBeGreaterThan(0);
    // Everything in this schema is expressible, so the pull must be complete. If this fails, read
    // coverage.skipped — it names exactly what the engine could not render.
    expect(coverage.skipped).toEqual([]);
    expect(coverage.complete).toBe(true);

    // `pull` does not emit base DDL — that is its documented boundary, so supply it.
    await target.query(BASE_DDL);
    for (const statement of migration.up) {
      await target.query(statement);
    }

    const before = await introspect(source);
    const after = await introspect(target);

    // The decisive assertion: same hypertable configuration, same CAGGs, same policies.
    expect(after.hypertables).toEqual(before.hypertables);
    expect(after.continuousAggregates).toEqual(before.continuousAggregates);
  }, 300_000);

  it('emits a down() that removes the policies it added without dropping any object', async () => {
    const { migration } = await pullSchema(source);
    const down = migration.down.join('\n');
    expect(down).toContain('remove_retention_policy');
    // Reverting must never destroy data. The earlier version of this test only checked
    // `drop_chunks` and `DROP TABLE` — neither of which matches `DROP MATERIALIZED VIEW`, so it
    // kept passing while `down()` dropped a pulled CAGG whose materialized rows may be the only
    // surviving copy of data its source chunks no longer hold. Assert on every drop form.
    expect(down).not.toMatch(/drop_chunks/i);
    expect(down).not.toMatch(/DROP TABLE/i);
    expect(down).not.toMatch(/DROP MATERIALIZED VIEW/i);
    expect(down).not.toMatch(/DROP VIEW/i);
  });

  it('is read-only: pulling twice changes nothing in the source', async () => {
    const before = await introspect(source);
    await pullSchema(source);
    await pullSchema(source);
    expect(await introspect(source)).toEqual(before);
  }, 120_000);
});
