# typeorm-timescaledb documentation

This directory is the developer documentation for `typeorm-timescaledb`.

Start with the tutorial if you want a complete local walkthrough, or use the
quickstart when you already have a TypeORM project and TimescaleDB database.

## Start here

1. [Overview](overview.md) — what the package is and what problem it solves.
2. [Installation](installation.md) — install requirements and peer dependencies.
3. [Tutorial](tutorial.md) — a 10-minute end-to-end local walkthrough.
4. [Quickstart](quickstart.md) — the shortest path from entity metadata to a
   TimescaleDB migration.
5. [Docker Compose local setup](../examples/docker-compose-local/README.md) —
   reusable local TimescaleDB setup with environment variables, DataSource
   config, setup command, migration command, and test command.
6. [Runnable quickstart example](../examples/quickstart/README.md) — standalone
   mini-project with install, setup, migration, demo, expected output, and
   cleanup commands.

## Core guides

- [Migration guide](migration-guide.md)
- [Query layer guide](query-layer.md)
- [NestJS guide](nestjs-guide.md)
- [Production guide](production-guide.md)
- [API reference](api-reference.md)

## Support docs

- [Troubleshooting](troubleshooting.md)
- [Compatibility](compatibility.md)
- [Limitations](limitations.md)

## Current scope

`typeorm-timescaledb` is a pre-1.0 foundation release. It currently focuses on
typed TimescaleDB hypertables, columnstore, retention, space partitioning,
migration generation, CLI commands, per-DataSource runtime access, schema drift
detection, NestJS support, dual ESM/CJS packaging, and the 0.2.x typed query
layer for TimescaleDB hyperfunctions.

Continuous aggregates, validated cross-store references, safer diff improvements,
and complete TimescaleDB feature coverage are planned or future scope, not
shipped 0.2.x functionality.

Automatic changes to existing TimescaleDB configuration are not a promised
package capability. Changes such as changing chunk intervals, replacing existing
policies, or other live-configuration changes require explicit hand-written
migrations controlled by the user.
