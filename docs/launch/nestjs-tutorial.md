# NestJS tutorial draft

> Working title: Use TimescaleDB in NestJS with TypeORM and explicit DataSource wiring

This tutorial is the public launch version of the NestJS story for `typeorm-timescaledb`.

The message for NestJS developers is simple: keep the database context explicit. Register the Timescale-aware module for the DataSource you want, register the entities you want to use, and inject repositories from the same context.

## What you will build

You will connect a NestJS application to a TimescaleDB-backed TypeORM DataSource and use a Timescale-aware repository for a `Reading` entity.

## Prerequisites

You need:

- a NestJS application;
- TypeORM configured for PostgreSQL;
- a TimescaleDB database;
- the `typeorm-timescaledb` package;
- compatible NestJS peer packages for your app.

Install the package and TypeORM dependencies with your package manager.

## Model the entity

Create a normal TypeORM entity for time-series readings. Add the TimescaleDB metadata with `@Hypertable()` and `@TimeColumn()`.

The entity remains a TypeORM entity. The TimescaleDB metadata is used by `typeorm-timescaledb` to generate reviewable migrations and to support package-specific runtime helpers.

## Register the module

Use the NestJS integration in two steps:

1. Register the DataSource with `TimescaleModule.forRoot(...)`.
2. Register the entities with `TimescaleModule.forFeature(...)`.

For one database context, the default context is enough.

For multiple DataSources, give the Timescale context a name such as `analytics` and use that exact name everywhere you register and inject Timescale repositories.

## Inject the repository

In your service, inject the Timescale repository for the entity and context you registered.

For the default context, inject the entity repository without a context name.

For a named context, pass the same context name used by `forRoot` and `forFeature`.

This explicit wiring is important because the package does not globally mutate TypeORM. If the wrong database is used, the problem is usually a NestJS module/context mismatch rather than hidden global behavior.

## Add a query

Use ordinary TypeORM repository methods for normal reads and writes. Use the query-layer guide when you need TimescaleDB expressions such as time buckets, gapfill, candlesticks, or toolkit-backed helpers.

For launch demos, keep the first query simple:

- insert a few readings;
- query the latest reading for a sensor;
- run a grouped hourly average;
- show the generated migration and hypertable verification query.

## Common mistakes

### Mixing context names

If the root module registration uses a named context, feature registration and repository injection must use the same name.

### Forgetting feature registration

Root registration makes the DataSource available. Feature registration makes specific entity repositories injectable.

### Expecting global TypeORM mutation

The package is designed to avoid global TypeORM mutation. Keep context names explicit, especially in apps with multiple DataSources.

### Running migrations from the wrong DataSource

The CLI uses the DataSource passed with `-d`. Make sure that DataSource includes the same entities and migration paths used by the NestJS module.

## Production notes

Before launching a NestJS service with this package:

- generate and review TimescaleDB migrations;
- run integration tests against a real TimescaleDB database;
- use `assertSchema()` where drift checks are useful;
- keep DataSource names consistent;
- document manual migrations for unsupported config changes;
- review the production and troubleshooting guides.

## Launch CTA

Try the NestJS integration if you need TimescaleDB behavior inside a TypeORM/NestJS application without hiding database changes at startup.
