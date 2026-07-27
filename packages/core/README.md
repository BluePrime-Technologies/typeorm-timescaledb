# @blueprime/timescaledb-core

> ORM-agnostic core for [`typeorm-timescaledb`](https://www.npmjs.com/package/typeorm-timescaledb):
> TimescaleDB SQL/DDL generation, the typed migration-operation IR, the schema diff engine, the
> hypertable metadata model, and identifier-safety helpers. **No TypeORM dependency.**

You usually don't install this directly — install
**[`typeorm-timescaledb`](https://www.npmjs.com/package/typeorm-timescaledb)**, which depends on it.
Reach for this package directly only if you are building your own integration (a different ORM, a
plain `pg` tool) on top of the same SQL and diff machinery.

Ships **dual ESM + CJS** with full type definitions. Requires Node `^20.19.0 || >=22.12.0` and
targets **TimescaleDB ≥ 2.18**.

## What's in it

- **SQL builders** — `createHypertableSQL`, `addColumnstorePolicySQL`, `addRetentionPolicySQL`,
  `alter{Compression,Retention}PolicySQL`, `setChunkIntervalSQL`, `alterColumnstoreConfigSQL`,
  `remove{Retention,Compression}PolicySQL`, `renameHypertableSQL`, the continuous-aggregate
  builders, and the hyperfunction/toolkit expression helpers. Each returns a reversible
  `{ up, down, inspect }` — and a generated `down` never destroys data.
- **The operation IR + one compile choke point** — every migration operation is data
  (`{ kind, ...input }`), and `compileOperation` is the single place that turns it into SQL. Every
  emit path (raw SQL, TypeScript classes, direct apply) routes through it, so they cannot drift
  apart.
- **The schema-state IR + diff engine** — `SchemaStateIR` is the canonical description of a
  TimescaleDB schema; `diffSchemaState(current, desired, opts?)` returns an ordered `Plan` whose
  steps each carry a **safety class** (`online-safe` · `needs-recompress` · `refuse-by-default` ·
  `one-way`) from `classifyOperation`, plus `compilePlan(plan)` for its `up`/`down` SQL.
- **The normalization layer** — `canonicalizeInterval` / `intervalsEqual` and the engine-default
  reconciliation that stop Postgres's interval reformatting and auto-filled defaults from reading
  as schema drift.
- **Identifier and literal safety** — `assertSafeIdentifier`, `quoteIdent`, `quoteLiteral`,
  `assertInterval`. Every identifier that reaches SQL passes an allow-list; values in literal
  position are quoted, never concatenated.

```ts
import { diffSchemaState, compilePlan, isEmptyPlan } from '@blueprime/timescaledb-core';

const plan = diffSchemaState(currentIR, desiredIR);
if (!isEmptyPlan(plan)) {
  for (const step of plan.steps) console.log(step.safety, step.operation.kind, step.reason);
  const { up, down } = compilePlan(plan); // ready-to-run SQL, reversible
}
```

Reading a live database into a `SchemaStateIR` (`introspect`) and compiling entities into the
desired one (`compileDesiredState`) live in `typeorm-timescaledb`, since they need the ORM.

Apache-2.0 © BluePrime Technologies.
