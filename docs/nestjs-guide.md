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

## Async setup with `forRootAsync`

`forRoot` requires an already-built `DataSource` at module-definition time. When
connection config comes from an async source instead — `ConfigService`, environment
loaded at runtime, a secrets fetch — use `forRootAsync`, which mirrors the standard
NestJS async-module pattern:

```ts
TimescaleModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    dataSource: buildDataSource(config),
    name: 'timeseries',
    assert: 'warn',
  }),
});
```

- `useFactory` may be synchronous or return a `Promise`.
- `inject` lists the providers passed positionally to `useFactory`, resolved from the
  module's own providers plus whatever `imports` brings in.
- `name` and `global` behave exactly as they do for `forRoot`.

### Optional / no-op registration

Some environments (local dev, unit tests) don't have a live TimescaleDB. Instead of
failing module construction, `useFactory` can resolve `undefined` to register a no-op
context: no `DataSource` is built, and the boot-time drift check does not run.

```ts
TimescaleModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const url = config.get('TIMESCALE_URL');
    if (!url) return undefined; // no-op: nothing registered under the context token
    return { dataSource: buildDataSource(url) };
  },
});
```

Any consumer that injects the context or a `forFeature` repository in an app that may
run in no-op mode must mark the dependency `@Optional()` — nothing is provided under
the token when `useFactory` resolves `undefined`, and a non-optional injection would
fail to resolve at startup:

```ts
constructor(
  @Optional() @InjectTimescaleContext() private readonly context?: TimescaleContext,
) {}
```

## Multiple DataSources

When an application has more than one TimescaleDB connection, use a shared name across module registration and repository injection. This preserves the package's no-global-mutation model.

## Peer dependencies

NestJS packages are optional peer dependencies. Install `@nestjs/common` and `@nestjs/core` only when using this integration.

## Next

A later expanded guide should include a complete NestJS module, service, and multi-DataSource example.
