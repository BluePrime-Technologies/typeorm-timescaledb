# NestJS guide

The package exposes an optional NestJS integration through the `typeorm-timescaledb/nestjs` subpath.

## What this guide will cover

This guide is the starting point for NestJS users. It will explain how to:

- Register a TimescaleDB DataSource in a NestJS app.
- Register entities with TimescaleDB metadata.
- Inject hypertable-aware repositories.
- Use named contexts for multiple DataSources.
- Run a boot-time schema drift check.

## Basic setup outline

A typical NestJS setup uses:

- `TimescaleModule.forRoot(...)` to register the DataSource.
- `TimescaleModule.forFeature(...)` to register entities.
- A repository injection helper for services that need hypertable-aware access.

## Multiple DataSources

When an application has more than one TimescaleDB connection, use a shared name across module registration and repository injection. This preserves the package's no-global-mutation model.

## Peer dependencies

NestJS packages are optional peer dependencies. Install `@nestjs/common` and `@nestjs/core` only when using this integration.

## Next

A later expanded guide should include a complete NestJS module, service, and multi-DataSource example.
