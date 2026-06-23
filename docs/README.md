# typeorm-timescaledb documentation

This directory is the documentation skeleton for `typeorm-timescaledb`.

The goal of Step 3 is to create the public documentation structure first, even
before every guide is complete. Each page gives users a clear starting point and
marks where deeper guides will be expanded next.

## Start here

1. [Overview](overview.md) — what the package is and what problem it solves.
2. [Installation](installation.md) — install requirements and peer dependencies.
3. [Quickstart](quickstart.md) — the shortest path from entity metadata to a TimescaleDB migration.
4. [Tutorial](tutorial.md) — placeholder for the full 10-minute walkthrough in Step 4.

## Core guides

- [Migration guide](migration-guide.md)
- [NestJS guide](nestjs-guide.md)
- [Production guide](production-guide.md)

## Support docs

- [Troubleshooting](troubleshooting.md)
- [Compatibility](compatibility.md)
- [Limitations](limitations.md)

## Current scope

`typeorm-timescaledb` is a pre-1.0 foundation release. It currently focuses on
typed TimescaleDB hypertables, columnstore, retention, space partitioning,
migration generation, CLI commands, per-DataSource runtime access, schema drift
detection, NestJS support, and dual ESM/CJS packaging.

Continuous aggregates, hyperfunction query expressions, safer diff improvements,
validated cross-store references, and complete TimescaleDB feature coverage are
planned or future scope, not shipped 0.1.x functionality.

Automatic destructive migrations are unsupported and should not be described as
a future package capability. Destructive or unsafe changes require explicit
hand-written migrations controlled by the user.
