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
 * Import a module by path and return its first `DataSource` export. The default
 * export is tried first, then named exports in declaration order. Each candidate is
 * awaited, so a module exporting `Promise<DataSource>` works too (the TypeORM CLI
 * convention).
 *
 * @throws {CliError} if the path is a `.ts` file Node can't import (no TS loader),
 *   or if the module exports no `DataSource`.
 */
export async function loadDataSource(modulePath: string): Promise<DataSource> {
  const url = pathToFileURL(resolve(modulePath)).href;

  let mod: Record<string, unknown>;
  try {
    mod = (await import(url)) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ERR_UNKNOWN_FILE_EXTENSION') {
      throw new CliError(
        `Cannot import the TypeScript DataSource "${modulePath}" — Node has no TypeScript loader active. ` +
          `Run the CLI through a loader (e.g. \`tsx\` or \`node --import ts-node/esm\`) or point -d at a compiled .js file.`,
      );
    }
    throw error;
  }

  const candidates =
    mod.default !== undefined ? [mod.default, ...Object.values(mod)] : Object.values(mod);
  for (const candidate of candidates) {
    const resolved = await candidate; // support Promise<DataSource> exports
    if (isDataSource(resolved)) return resolved;
  }
  throw new CliError(
    `No DataSource export found in ${modulePath} — export your DataSource (e.g. \`export default new DataSource(...)\`)`,
  );
}

/**
 * Initialize a DataSource for CLI use. Mirrors TypeORM's own CLI: before connecting,
 * disable any startup mutations (`synchronize`, `migrationsRun`, `dropSchema`) and
 * subscribers so that merely running a command never alters the schema. A DataSource
 * that is already initialized is left untouched.
 */
export async function initializeForCli(dataSource: DataSource): Promise<void> {
  if (dataSource.isInitialized) return;
  dataSource.setOptions({
    subscribers: [],
    synchronize: false,
    migrationsRun: false,
    dropSchema: false,
  });
  await dataSource.initialize();
}
