# @blueprime/cross-store

> Validated cross-**database** `@Resolve` references — application-level referential integrity
> between two _separate_ database instances (e.g. a TimescaleDB events store and a canonical
> Postgres store) that cannot share a SQL foreign key.

It is **not** FDW / dblink / logical replication: integrity is enforced in the application against
the two connections it already holds. The guarantee is honest and best-effort — there is a TOCTOU
window across instances, mitigated (not eliminated) by append-only reference targets, a
caller-transaction validate-then-write, and a reconciliation sweep. That is why this lives in a
package apart from the zero-bug ORM core.

## Install

```sh
npm install @blueprime/cross-store
```

Ships **ESM-only** with full type definitions. Requires Node `^20.19.0 || >=22.12.0`. The ORM is an
**optional peer** — install whichever adapter you use:

```sh
npm install typeorm         # TypeORM / any pg-style SqlRunner target
npm install @prisma/client  # or a Prisma target
```

## The shape

- **`ReferenceRegistry`** — the anti-injection allowlist of every referenceable `(store, table,
column)` (+ optional scope columns). Every identifier is validated at registration.

  ```ts
  import { ReferenceRegistry } from '@blueprime/cross-store';

  const registry = new ReferenceRegistry()
    .register({ store: 'canonical', table: 'accounts', column: 'id', targetIsAppendOnly: true })
    .register({
      store: 'canonical',
      table: 'categories',
      column: 'name',
      scopeColumns: ['workspace_id'],
    });
  ```

- **`resolveReferences(checks, { registry, adapters, validators })`** — the batched resolve engine
  (one `findMany` per `(store, table, column, scope)` group; `ADAPTER_UNAVAILABLE` is **never**
  collapsed into `not_found`). Pair with **`assertAllResolved(verdicts)`** to fail closed.
- **Adapters** (structural — the ORM is never imported by the core):
  - `@blueprime/cross-store/typeorm` — `DataSourceAdapter` over a structural `SqlRunner` (anything
    with `query(sql, params)`, e.g. a `pg.Pool` or a TypeORM `DataSource`).
  - `@blueprime/cross-store/prisma` — `PrismaAdapter` over a `PrismaClientLike` (`$queryRawUnsafe`).
    Uses `col::text = ANY($1)` because Prisma binds parameters type-strictly.
- **`@Resolve('store.table.column', { scope, validators, required })`** + `resolveEntities` — the
  entity declaration surface (decorator).
- **`createManyResolved` / `verifyReferences`** (`@blueprime/cross-store/typeorm`) — validate-then-write
  inside the caller's transaction (with a save-time re-check that closes the value **and** scope TOCTOU
  windows), and a reconciliation sweep that partitions `{ dangling, unavailable }`.

Domain policy (the concrete validators, the concrete registry contents) is supplied by the
application; this package ships only the generic mechanism.

## Error taxonomy

`CrossStoreError` distinguishes `REFERENCE_NOT_FOUND` (the referenced row genuinely does not exist)
from `ADAPTER_UNAVAILABLE` (the target store was unreachable — a transient failure that must **not**
be treated as a broken reference). A reconciliation sweep therefore reports a store outage under
`unavailable`, never as a false `dangling`.

## Status

Pre-1.0 (`0.2.x`). The `@Resolve` API surface is still settling — expect additive change. Tested
against real Postgres/TimescaleDB via Testcontainers.

## License

Apache-2.0 © BluePrime Technologies. Maintained by Miracle Adebunmi ([@madebunmi-prime](https://github.com/madebunmi-prime)).
