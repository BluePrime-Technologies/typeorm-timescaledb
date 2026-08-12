import 'reflect-metadata';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { DataSource } from 'typeorm';

const IMAGE = process.env.TIMESCALE_IMAGE ?? process.env.TIMESCALE_TOOLKIT_IMAGE;

/**
 * The catalog contract: every column this library reads must exist on the running TimescaleDB.
 *
 * Why this test exists. The catalog is not a stable API and it moved under us repeatedly —
 * `_timescaledb_catalog.chunk` lost `schema_name`, `table_name` and `compressed_chunk_id` in 2.29;
 * `compression_settings.relid` changed WHICH relation it keys on between 2.18 and 2.28. Each time,
 * the symptom was not an error but a silently wrong answer: a `LEFT JOIN` on a column that no longer
 * matches yields NULLs, and NULLs read as "not compressed" or "no settings" rather than "we cannot
 * see". Every one of those was found by a behavioural test that happened to notice, which is luck,
 * not coverage.
 *
 * So this asserts the dependency directly and per matrix leg: for each catalog relation, the columns
 * we select are a SUBSET of the columns the live server actually has. It runs on every version in the
 * matrix, so a leg that drops a column fails here — naming the relation and the column — instead of
 * surfacing three files away as a plausible-looking wrong result.
 *
 * It also fails if a future refactor replaces an explicit column list with `SELECT *` (see the last
 * case): a star-select cannot be checked against anything, and it silently re-couples us to whatever
 * shape the catalog happens to have, which is precisely the coupling this file exists to bound.
 */

/** A relation we read, and the columns we name in SELECT lists, JOINs and WHERE clauses. */
interface CatalogDependency {
  readonly relation: string;
  readonly columns: readonly string[];
  /**
   * `true` when the runtime has a documented fallback for this relation being absent, so its absence
   * is a supported degradation rather than a break. The COLUMNS are still checked when the relation
   * exists — a fallback covers "cannot read it at all", not "read it and got NULL".
   */
  readonly optional?: boolean;
  /**
   * `true` for a branch that is tried only on older servers and is expected to become unreadable on
   * newer ones. Its columns are then asserted ALL-OR-NOTHING rather than all-present: a version that
   * has every column supports the branch, and one that has none of them never reaches it.
   *
   * A PARTIAL disappearance is the failure this encodes, and it is the genuinely dangerous shape —
   * the JOIN still compiles against the columns that remain, matches nothing, and yields the NULLs
   * that read as "not compressed". Tolerating "some missing" would have permitted exactly that.
   */
  readonly legacy?: boolean;
}

const DEPENDENCIES: readonly CatalogDependency[] = [
  {
    relation: 'timescaledb_information.hypertables',
    columns: [
      'hypertable_schema',
      'hypertable_name',
      'num_dimensions',
      'num_chunks',
      'compression_enabled',
    ],
  },
  {
    relation: 'timescaledb_information.chunks',
    columns: [
      'hypertable_schema',
      'hypertable_name',
      'chunk_schema',
      'chunk_name',
      'range_start',
      'range_end',
      // Integer-time hypertables leave the timestamp pair NULL and populate these instead. Selecting
      // only the timestamps reported every chunk of such a hypertable as having no range at all.
      'range_start_integer',
      'range_end_integer',
      'is_compressed',
    ],
  },
  {
    relation: 'timescaledb_information.continuous_aggregates',
    columns: ['view_schema', 'view_name', 'materialized_only', 'compression_enabled'],
  },
  {
    relation: 'timescaledb_information.jobs',
    columns: [
      'job_id',
      'application_name',
      'schedule_interval',
      'proc_schema',
      'proc_name',
      // On 2.18 these name the INTERNAL materialization hypertable for a cagg policy; on 2.28+ they
      // name the user-facing view. `listJobs` carries a dual predicate for exactly that divergence.
      'hypertable_schema',
      'hypertable_name',
      'scheduled',
      'config',
    ],
  },
  {
    relation: 'timescaledb_information.job_stats',
    columns: [
      'job_id',
      'hypertable_schema',
      'hypertable_name',
      'last_run_started_at',
      'last_successful_finish',
      'last_run_status',
      'job_status',
      'total_runs',
      'total_successes',
      'total_failures',
      'next_start',
    ],
  },
  {
    relation: 'timescaledb_information.dimensions',
    columns: [
      'hypertable_schema',
      'hypertable_name',
      'time_interval',
      'dimension_type',
      'dimension_number',
    ],
  },
  {
    // Not a public view. Read for per-chunk columnstore settings, which no public view exposes; the
    // recompress path degrades to an explicit `imprecisionReason` when it cannot be read.
    relation: '_timescaledb_catalog.compression_settings',
    columns: ['relid', 'segmentby', 'orderby', 'orderby_desc', 'orderby_nullsfirst'],
    optional: true,
  },
  {
    // The LEGACY branch only, for 2.18-era servers. 2.29 removed all three of the columns below,
    // which is why the modern query drives off the public `chunks` view instead and this branch is
    // tried only when that resolves nothing.
    relation: '_timescaledb_catalog.chunk',
    // `id` is excluded deliberately: it survives on every version, so including it would make the
    // all-or-nothing check unsatisfiable on 2.29 (one present, three absent) for a reason that has
    // nothing to do with the drift being guarded.
    columns: ['schema_name', 'table_name', 'compressed_chunk_id'],
    optional: true,
    legacy: true,
  },
];

describe.skipIf(!IMAGE)('catalog contract — the columns we read exist on this server', () => {
  let container: StartedTestContainer;
  let ds: DataSource;
  let version: string;

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
    const rows: Array<{ extversion: string }> = await ds.query(
      `SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'`,
    );
    version = rows[0]?.extversion ?? 'unknown';
  }, 300_000);

  afterAll(async () => {
    await ds?.destroy();
    await container?.stop();
  });

  /**
   * `information_schema.columns` covers views but NOT the catalog tables in a non-exposed schema, so
   * the lookup goes through `pg_attribute`, which covers both. Dropped columns are excluded
   * (`attisdropped`), as are the system columns (`attnum > 0`) that no query of ours names.
   */
  const liveColumns = async (relation: string): Promise<Set<string> | undefined> => {
    const [schema, name] = relation.split('.');
    const rows: Array<{ attname: string }> = await ds.query(
      `SELECT a.attname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped`,
      [schema, name],
    );
    return rows.length === 0 ? undefined : new Set(rows.map((r) => r.attname));
  };

  for (const dep of DEPENDENCIES) {
    it(`${dep.relation}: every column we read is present`, async () => {
      const live = await liveColumns(dep.relation);

      if (live === undefined) {
        // A required relation vanishing is a break; an optional one has a documented fallback, and
        // the message records which leg exercised that fallback so the matrix stays informative.
        expect(
          dep.optional,
          `${dep.relation} does not exist on TimescaleDB ${version}, and no fallback is documented for it`,
        ).toBe(true);
        return;
      }

      const missing = dep.columns.filter((column) => !live.has(column));

      if (dep.legacy === true && missing.length === dep.columns.length) {
        // Wholly gone: this server is newer than the branch, and the branch is unreachable on it.
        // Measured: 2.29.1 removed schema_name, table_name and compressed_chunk_id together.
        return;
      }

      expect(
        missing,
        `TimescaleDB ${version} has no ${missing.map((c) => `${dep.relation}.${c}`).join(', ')} — ` +
          `a query naming it does not error, it returns NULL, which this library reads as ` +
          `"absent" rather than "unreadable". Update the query and the compatibility matrix.`,
      ).toEqual([]);
    });
  }

  it('reads the catalog only through explicit column lists, never SELECT *', () => {
    // Static, but it belongs with the assertions above: they are only as complete as the column
    // lists they check, and a star-select is a dependency that cannot be listed. Scanning the built
    // source rather than trusting review is the difference between a bound coupling and a habit.
    const roots = [
      join(import.meta.dirname, '../src/runtime'),
      join(import.meta.dirname, '../../core/src/sql'),
    ];
    const offenders: string[] = [];

    for (const root of roots) {
      for (const file of readdirSync(root).filter((f) => f.endsWith('.ts'))) {
        const source = readFileSync(join(root, file), 'utf8');
        // `SELECT *` / `SELECT DISTINCT *` reaching a timescaledb relation in the same statement.
        // `SELECT 1 FROM …` and `count(*)` are fine — neither depends on the column list.
        for (const match of source.matchAll(
          /SELECT\s+(?:DISTINCT\s+)?\*[\s\S]{0,400}?(timescaledb_information\.\w+|_timescaledb_catalog\.\w+)/gi,
        )) {
          offenders.push(`${file}: SELECT * from ${match[1]}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
