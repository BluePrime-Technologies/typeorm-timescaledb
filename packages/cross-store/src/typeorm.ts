/**
 * `@blueprime/cross-store/typeorm` — the TypeORM store adapter.
 *
 * A separate entrypoint so the core (`@blueprime/cross-store`) never imports an ORM. The adapter
 * itself is structurally typed (see {@link SqlRunner}), so `typeorm` is an **optional** peer: a
 * TypeORM `DataSource`/`EntityManager`/`QueryRunner` satisfies it, but nothing here imports the
 * `typeorm` package.
 */
export { DataSourceAdapter } from './adapters/data-source.js';
export type { DataSourceAdapterOptions, SqlRunner } from './adapters/data-source.js';
export { buildFindManySql } from './sql/find-many.js';
export type { FindManySql } from './sql/find-many.js';
