# Production guide

This guide explains how to use the current 0.1.x scope safely in real TypeORM projects.

## Production model

- TypeORM owns the base table.
- `typeorm-timescaledb` adds the TimescaleDB layer.
- Generated migrations are reviewable.
- Generated `down()` methods are non-destructive.
- Runtime access is scoped to a `DataSource`.
- Drift checks can fail fast when the live database no longer matches supported entity metadata.

## Migration safety

Generated migrations are additive and desired-state oriented. They are designed to apply supported TimescaleDB configuration idempotently.

Use hand-written migrations when removing or altering existing TimescaleDB configuration.

## Operational recommendations

- Review generated migrations before applying them.
- Run integration tests against a real TimescaleDB instance.
- Use `assertSchema` in environments where boot-time drift detection is valuable.
- Keep TypeORM migrations and TimescaleDB migrations ordered deliberately.
- Document manual migrations that change existing policies or dimensions.

## Not yet covered

This skeleton will later expand into deployment guidance, rollback examples, upgrade notes, and production troubleshooting.
