import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DataSource } from 'typeorm';
import { CliError } from './args.js';

/** Duck-type a value as a TypeORM `DataSource` (we only import the type). */
export function isDataSource(value: unknown): value is DataSource {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.initialize === 'function' &&
    typeof o.runMigrations === 'function' &&
    'entityMetadatas' in o
  );
}

/**
 * Import a module by path and return its first `DataSource` export (default export
 * first, then named exports in declaration order) — the TypeORM CLI convention.
 *
 * @throws {CliError} if the module exports no `DataSource`.
 */
export async function loadDataSource(modulePath: string): Promise<DataSource> {
  const url = pathToFileURL(resolve(modulePath)).href;
  const mod = (await import(url)) as Record<string, unknown>;
  const candidates =
    mod.default !== undefined ? [mod.default, ...Object.values(mod)] : Object.values(mod);
  for (const candidate of candidates) {
    if (isDataSource(candidate)) return candidate;
  }
  throw new CliError(
    `No DataSource export found in ${modulePath} — export your DataSource (e.g. \`export default new DataSource(...)\`)`,
  );
}
