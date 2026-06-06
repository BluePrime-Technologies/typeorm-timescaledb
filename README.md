# typeorm-timescaledb

> A complete, multi-DataSource-safe [TimescaleDB](https://www.tigerdata.com/) integration for [TypeORM](https://typeorm.io/).

**The goal:** every TimescaleDB capability — hypertables, Hypercore columnstore, retention, continuous aggregates, and every hyperfunction — expressed through typed ORM constructs, so you never have to hand-write TimescaleDB SQL. An ORM is a mapper; this package does the mapping work for TimescaleDB the way Django's ORM does it for Postgres.

## Why this exists

The existing TypeORM ↔ TimescaleDB packages (`@timescaledb/typeorm` and its fork) are abandoned and share a fatal bug: they **globally reassign `DataSource.prototype`** at import, which breaks any application that runs more than one `DataSource` (the standard NestJS "Postgres + TimescaleDB" setup). One of them even deletes data on migration rollback.

`typeorm-timescaledb` is built on one hard rule:

> **No global mutation. Ever.** Every extension is scoped to the `DataSource` you pass in — proven by a CI gate that boots two DataSources and asserts the plain one is untouched.

## Status

🚧 Early development. Built first for [BluePrime](https://blueprime.app)'s own use; published openly under Apache-2.0. APIs may change before `1.0`.

## Design principles

1. **Full coverage, no gaps.** Every TimescaleDB feature gets a first-class typed construct — decorators for schema, query-builder expression classes for hyperfunctions, typed result objects for non-entity result shapes. A raw `tsRaw` passthrough exists for convenience, never as an excuse to leave a feature unmapped.
2. **Multi-DataSource safe.** No prototype patching, no global singletons. Composition and explicit per-DataSource factories only.
3. **Migration-driven DDL.** Hypertables, policies, and continuous aggregates are created via reviewable migrations — never `synchronize: true`. Rollbacks never destroy data.
4. **Tested against real TimescaleDB.** Integration tests run against a real TimescaleDB container and assert against `timescaledb_information.*` catalog views, not SQL strings.

## Packages

| Package                                    | Description                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| `typeorm-timescaledb`                      | The TypeORM integration: decorators, repository, migrations, NestJS module.             |
| `@blueprime-technologies/timescaledb-core` | ORM-agnostic SQL/DDL generation, metadata model, identifier safety.                     |
| `@blueprime-technologies/cross-store`      | Validated cross-store (`@Resolve`) references between TimescaleDB and another database. |

## License

Apache-2.0 © BluePrime Technologies. Maintained by Miracle Adebunmi ([@madebunmi-prime](https://github.com/madebunmi-prime)). See [MAINTAINERS.md](./MAINTAINERS.md).
