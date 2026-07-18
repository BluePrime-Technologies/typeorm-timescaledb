/**
 * `@blueprime/cross-store/typeorm` — the TypeORM `DataSource` adapter. A separate subpath so
 * the package's main entrypoint (`@blueprime/cross-store`) never imports `typeorm`; only code
 * that imports from here needs `typeorm` installed (an optional peer dependency).
 */
export { DataSourceAdapter } from './data-source-adapter.js';
export type { DataSourceAdapterOptions } from './data-source-adapter.js';
