# Migration guide

`typeorm-timescaledb` is migration-driven. It generates reviewable TimescaleDB
migrations from supported entity metadata.

## Responsibility split

TypeORM is responsible for the base table:

- Entity definition.
- Base `CREATE TABLE`.
- Regular TypeORM schema changes.

`typeorm-timescaledb` is responsible for the TimescaleDB layer:

- Converting the table into a hypertable.
- Applying chunk interval configuration.
- Applying columnstore configuration and policies.
- Applying retention policies.
- Applying space/hash partitioning.

## Database prerequisite

The target database must have the TimescaleDB extension enabled before the
generated migration calls TimescaleDB functions:

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;
```

Create the extension through your database setup, an earlier migration, or a
manual administrative step.

## DataSource migrations configuration

The `generate` command writes a migration file to the output directory you pass
with `-o`. The `run` command does not read `-o`; it delegates to TypeORM's
`dataSource.runMigrations()`.

That means the generated path must also be included in the DataSource
`migrations` option, or the run step can report no pending migrations.

```ts
export const AppDataSource = new DataSource({
  // ...the rest of your DataSource options
  migrations: ['src/migrations/*.{ts,js}'],
});
```

## Generate

Compiled JavaScript DataSource:

```sh
npx typeorm-timescaledb generate -d dist/data-source.js -o dist/migrations
```

TypeScript DataSource with a loader:

```sh
npx tsx node_modules/typeorm-timescaledb/dist/cli/main.js generate -d src/data-source.ts -o src/migrations
```

## Run

Compiled JavaScript DataSource:

```sh
npx typeorm-timescaledb run -d dist/data-source.js
```

TypeScript DataSource with a loader:

```sh
npx tsx node_modules/typeorm-timescaledb/dist/cli/main.js run -d src/data-source.ts
```

## Revert

```sh
npx typeorm-timescaledb revert -d dist/data-source.js
```

Generated `down()` methods are intentionally non-destructive. They should not
drop data or undo hypertable conversion in a destructive way.

## Empty-table assumption for generated hypertable conversion

Generated hypertable conversion assumes the base table is empty. If the TypeORM
base table already contains rows, do not rely on the generated conversion as the
safe path.

For existing data, write a hand-authored migration and data-migration plan that
explicitly handles TimescaleDB conversion and data movement for your table.

## The migration engine (0.6.0)

`generate` emits a **desired-state** migration from your entities. Separately, the
migration engine reconciles a **live database** against those entities: it reads what the
database actually has, diffs it, and converges it — with every step classified by how
risky it is to apply.

```ts
import { introspect, compileDesiredState, applyDirect } from 'typeorm-timescaledb';
import { diffSchemaState, isEmptyPlan } from '@blueprime/timescaledb-core';

const plan = diffSchemaState(await introspect(dataSource), compileDesiredState(dataSource));

if (!isEmptyPlan(plan)) {
  for (const step of plan.steps) {
    console.log(`[${step.safety}] ${step.operation.kind} — ${step.reason}`);
  }
  await applyDirect(dataSource, plan); // one transaction; refuses dangerous ops by default
}
```

Each step carries a `SafetyClass`: `online-safe`, `needs-recompress`, `refuse-by-default`,
or `one-way`. `applyDirect` refuses anything classified `refuse-by-default` unless you pass
`{ allowRefuseByDefault: true }`, and it derives that classification from the operation
itself — a hand-built plan cannot mislabel a dangerous change past the gate.

For CI, the `check` verb is the same diff with a non-zero exit on drift:

```sh
npx typeorm-timescaledb check -d src/data-source.ts
```

Prefer a reviewable artifact over a direct apply? `planToMigration(plan)` turns the same
plan into a committable migration, and `TimescaleSchemaBuilder` lets you hand-author one
that runs inside an ordinary TypeORM migration via `queryRunner`.

### What the engine reconciles

Auto-diffed today:

- compression and retention thresholds;
- the time-dimension chunk interval;
- the columnstore segment-by / order-by configuration;
- renames declared with `@Hypertable({ renamedFrom })`;
- removing a retention or compression policy — **only** with `allowDrops` enabled, and
  always reversibly.

## Manual migrations

The engine never performs a destructive change. Write a hand-authored migration for:

- **dropping a hypertable or disabling a columnstore** — never auto-generated;
- **adding, removing, or re-partitioning a space (hash) dimension** — `add_dimension` is
  one-way and re-partitioning is not expressible, so a divergence is reported as an error
  naming the required migration rather than silently ignored;
- **structural changes to continuous aggregates** — the diff is hypertable-scoped and does
  not compile CAGGs, so `check` does not cover CAGG drift.
