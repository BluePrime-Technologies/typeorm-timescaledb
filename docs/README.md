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
- [Supply-chain security](supply-chain-security.md)

## Launch materials

- [Launch materials index](launch/README.md)
- [Launch blog post draft](launch/blog-post.md)
- [TimescaleDB + TypeORM tutorial](launch/typeorm-timescaledb-tutorial.md)
- [NestJS tutorial](launch/nestjs-tutorial.md)
- [Migration safety article](launch/migration-safety-article.md)
- [Short demo script](launch/demo-script.md)
- [Social posts](launch/social-posts.md)
- [Community sharing checklist](launch/community-sharing-checklist.md)

## Current scope

`typeorm-timescaledb` is a pre-1.0 release line. It currently focuses on typed
TimescaleDB hypertables, columnstore, retention, space partitioning, migration
generation, CLI commands, per-DataSource runtime access, schema drift detection,
NestJS support, dual ESM/CJS packaging, and the typed query layer introduced in
0.2.x.

The 0.3.0 release scope expands toolkit-backed repository helpers for the stable
`timescaledb_toolkit` aggregate families implemented by this package, including
stats/regression, UddSketch percentiles, counters, time-weight, state tracking,
most-common-values, and heartbeat/liveness helpers.

Continuous aggregates, validated cross-store references, safer diff improvements,
experimental toolkit aggregates, stable Toolkit aggregates that are not listed in
the query-layer guide, and complete TimescaleDB feature coverage are planned or
future scope.

Automatic changes to existing TimescaleDB configuration are not a promised
package capability. Changes such as changing chunk intervals, replacing existing
policies, or other live-configuration changes require explicit hand-written
migrations controlled by the user.
