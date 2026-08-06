# Migration guide

`typeorm-timescaledb` is migration-driven. It generates reviewable TimescaleDB
migrations from supported entity metadata, and — since **0.6.0** — can also read
a live database, diff it against your entities, and converge it directly.

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

`generate` derives an **additive / desired-state** migration from your
`@Hypertable` entities: the full hypertable setup, written idempotently
(`if_not_exists`). Pass `--output sql` to emit a reviewable raw `.sql` file
instead of a TypeORM migration class (default `ts`):

```sh
npx typeorm-timescaledb generate -d src/data-source.ts -o src/migrations --output sql
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

## Migration engine (0.6.0): diffing a live database

Where `generate` only ever emits new, additive DDL, the migration engine reads
what the database actually has and converges it toward your entities — reporting
what changed, not just what's missing.

### `check`: the CI drift gate

```sh
npx typeorm-timescaledb check -d src/data-source.ts
```

`check` introspects the live database, diffs it against your `@Hypertable`
declarations, prints a readable preview of any drift, and exits non-zero if
drift is found — a schema gate for CI. It reports drift; it does not apply
anything.

### Making `check` and `push` see your continuous aggregates

Continuous aggregates **cannot be discovered automatically.** A
`@ContinuousAggregate` class is not a TypeORM entity, and its metadata lives in a
module-private `WeakMap`, so nothing reachable from a `DataSource` can enumerate
them. Export them by name from your DataSource module and both verbs pick them
up:

```ts
// src/data-source.ts
export default new DataSource({ entities: [Reading] });
export const continuousAggregates = [ReadingHourly];
```

If you omit the export, `check` and `push` compare **no** aggregates — and say
so, rather than reporting a clean run:

```
No drift detected — schema matches the @Hypertable declarations.

Not compared:
  - (all continuous aggregates): No continuous aggregates were passed, so NONE
    were compared — a declared aggregate missing from this database would not be
    reported. …
```

Export an empty array to state affirmatively that your project has none; that
produces no warning.

**What is compared, and what is not.** An aggregate you declare that the database
lacks is created (with its refresh policy), and a declared refresh policy missing
from an existing aggregate is attached. An aggregate that **already exists** is
never dropped and never recreated, and its definition is not compared — the
catalog reports a parse-tree deparse (`INTERVAL '1 hour'` reads back as
`'01:00:00'::interval`, identifiers lose their quoting), so an unchanged
aggregate would not textually match and `push --apply` would recreate it,
destroying materialized rows. Every existing aggregate is therefore listed under
`Not compared:` — change one, and you change it by hand. A refresh policy whose
threshold has changed is reported under `Not auto-converged:` and **counts as
drift**, so `check` still exits non-zero.

### `mix`: both directions at once, for adopting on an existing database

```sh
npx typeorm-timescaledb mix        # preview both halves
```

Adopting this library on a database you did not model means answering two questions together:
_what is in my database that my entities do not describe?_ and _what do my entities declare that my
database lacks?_ `mix` answers both in one run — it **pulls first**, then shows the push plan.

The pull runs first on purpose: it records the database as it _was_, not as a convergence left it.
If the pull is incomplete, `mix` says so **before** showing the push plan, because converging toward
code that does not yet describe your database is how something gets dropped.

Its push half previews by default and takes the same `--apply` / `--allow-drops` /
`--allow-refused` flags, with the same meanings. It exits non-zero unless **both** halves are
clean — a run that is half clean is not clean.

> **There is no `sync` verb.** `push --apply` _is_ the synchronize mode: it converges the database
> to your code, refuses `refuse-by-default` steps unless you pass `--allow-refused`, and never drops
> without `--allow-drops`. A second verb doing the same job would be surface without behaviour.

### The programmatic API: read → diff → apply

The same engine is three calls, each telling you how risky the next one is
before you run it:

```ts
import { introspect, compileDesiredState, applyDirect } from 'typeorm-timescaledb';
import { diffSchemaState, isEmptyPlan } from '@blueprime/timescaledb-core';

const plan = diffSchemaState(await introspect(dataSource), compileDesiredState(dataSource));

if (!isEmptyPlan(plan)) {
  for (const step of plan.steps) {
    console.log(`[${step.safety}] ${step.operation.kind} — ${step.reason}`);
  }
  // Refuses any refuse-by-default step unless you opt in; runs in one transaction.
  await applyDirect(dataSource, plan);
}
```

Every `Plan` step carries a safety class: `online-safe`, `needs-recompress`,
`one-way`, or `refuse-by-default` (the last is never applied unless you pass
`{ allowRefuseByDefault: true }` to `applyDirect`). See
[API reference](./api-reference.md#migration-engine) for the full surface.

Prefer a reviewable artifact over a direct apply? Turn a `Plan` into a
committable migration with `planToMigration(plan)`, or hand-author one with the
fluent `TimescaleSchemaBuilder` instead of diffing at all:

```ts
import { TimescaleSchemaBuilder } from 'typeorm-timescaledb';

export class AddRetention1700000000000 implements MigrationInterface {
  private readonly schema = new TimescaleSchemaBuilder().addRetentionPolicy({
    table: 'reading',
    dropAfter: '90 days',
  });

  up = (qr: QueryRunner) => this.schema.up(qr);
  down = (qr: QueryRunner) => this.schema.down(qr); // reversible, never destructive
}
```

### What the engine auto-diffs

`diffSchemaState` detects and converges, on an existing hypertable:

- A missing columnstore or retention policy (additive).
- A changed compression or retention **threshold**.
- A changed **chunk interval**.
- A changed columnstore **segment-by / order-by** configuration.
- A renamed hypertable (`@Hypertable({ renamedFrom })`) — one `ALTER TABLE ...
RENAME` instead of a drop-then-create.

Removing a retention or compression policy that's present in the database but
absent from your entities is a **guarded drop**: pass `{ allowDrops: true }` to
`diffSchemaState` to opt in. It is reversible (`down()` re-adds the policy at
its prior threshold) and is never emitted by default.

### Manual migrations: what still needs a hand-written migration

The engine deliberately never touches two areas, regardless of `allowDrops`:

- **Continuous aggregates** — the diff is hypertable-scoped; CAGG structural
  changes are not detected or converged. Use `generateTimescaleMigration(...,
{ continuousAggregates: [...] })` or a hand-written migration.
- **Space (hash) dimensions** — adding, removing, or re-partitioning an
  existing space dimension is not reconcilable in place; a divergence is
  reported as an error naming the required manual migration.

And two operations are never auto-generated at all, by design:

- **Destructive drops** — dropping a hypertable or disabling a columnstore is
  always a hand-written migration.
- **Shortening a retention threshold** — the apply itself deletes nothing, but
  the next scheduler tick drops chunks that were previously retained and
  `down()` cannot restore them, so this is classified `refuse-by-default` and
  needs an explicit opt-in even through the programmatic API.

For any of the above, write an explicit TypeORM migration (optionally using
`TimescaleSchemaBuilder` for the DDL you already have covered) and review the
generated SQL before applying it.
