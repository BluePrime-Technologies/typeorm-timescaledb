# @blueprime/cross-store

> **Pre-release — not yet published to npm.** This package is `private` while its API settles
> and gets dogfooded in a real application. Do not depend on it yet.

Validated cross-**database** `@Resolve` references — application-level referential integrity
between two _separate_ database instances (e.g. a TimescaleDB events store and a canonical
Postgres store) that cannot share a SQL foreign key.

It is **not** FDW / dblink / logical replication: integrity is enforced in the application against
the two connections it already holds. The guarantee is honest and best-effort — there is a TOCTOU
window across instances, mitigated (not eliminated) by append-only reference targets, a
caller-transaction validate-then-write, and a reconciliation sweep. That is why this lives in a
package apart from the zero-bug ORM core.

## Shape

- **`ReferenceRegistry`** — the anti-injection allowlist of every referenceable `(store, table,
column)` (+ scope columns); every identifier is validated at registration.
- **`resolveReferences(checks, { registry, adapters, validators })`** — the batched resolve engine
  (one `findMany` per group; `ADAPTER_UNAVAILABLE` is never collapsed into `not_found`).
- **Adapters** — `@blueprime/cross-store/typeorm` (`DataSourceAdapter`) and
  `@blueprime/cross-store/prisma` (`PrismaAdapter`); the ORM is an optional peer, never imported by
  the core.
- **`@Resolve('store.table.column', { scope, validators, required })`** + `resolveEntities` — the
  entity declaration surface.
- **`createManyResolved` / `verifyReferences`** (`./typeorm`) — validate-then-write inside the
  caller's transaction, and a reconciliation sweep that partitions `{ dangling, unavailable }`.

Domain policy (concrete validators, the concrete registry contents) is supplied by the application;
this package ships only the generic mechanism.

## License

Apache-2.0.
