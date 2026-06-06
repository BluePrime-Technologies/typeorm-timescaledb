/**
 * typeorm-timescaledb — a multi-DataSource-safe TimescaleDB integration for TypeORM.
 *
 * Scaffold only. Feature implementation (decorators, TimescaleRepository,
 * migration codegen, NestJS module) lands in subsequent milestones — see
 * `.plans/2026-06-06-typeorm-timescaledb-oss-package.md`.
 */
export { TimescaleError, TimescaleErrorCode } from '@blueprime-technologies/timescaledb-core';

/** Package version marker; replaced by real exports as features land. */
export const PACKAGE_NAME = 'typeorm-timescaledb';
