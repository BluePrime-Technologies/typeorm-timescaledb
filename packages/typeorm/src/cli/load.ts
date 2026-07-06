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
 * Classify a caught module-import error into an actionable {@link CliError}, or
 * return `undefined` if the error should be rethrown as-is. Pulled out of
 * {@link loadDataSource} so the classification rules are unit-testable with
 * synthetic errors, independent of which Node version/loader is actually running.
 */
export function classifyLoadError(error: unknown, modulePath: string): CliError | undefined {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ERR_UNKNOWN_FILE_EXTENSION') {
    return new CliError(
      `Cannot import the TypeScript DataSource "${modulePath}" — Node has no TypeScript loader active. ` +
        `Run the CLI through a loader (e.g. \`tsx\` or \`node --import ts-node/esm\`) or point -d at a compiled .js file.`,
    );
  }
  // Node ≥ 22.18's native type stripping imports a .ts file directly without a
  // loader, but it does not remap the file's ".js" import specifiers back to their
  // sibling ".ts" files, so a project written for tsx-style ".js" specifiers fails
  // here with ERR_MODULE_NOT_FOUND instead of ERR_UNKNOWN_FILE_EXTENSION.
  if (code === 'ERR_MODULE_NOT_FOUND' && modulePath.endsWith('.ts')) {
    return new CliError(
      `Cannot import the TypeScript DataSource "${modulePath}" — Node loaded the .ts file directly ` +
        `(native type stripping) but could not resolve one of its imports (${(error as Error).message}). ` +
        `This typically happens when ".js"-suffixed import specifiers meant for a loader like \`tsx\` are ` +
        `resolved natively instead. Run the CLI through \`tsx\` (or another TypeScript loader that remaps ` +
        `".js" specifiers to ".ts") or point -d at a compiled .js file whose imports already resolve to ` +
        `compiled output.`,
    );
  }
  return undefined;
}

/**
 * Import a module by path and return its first `DataSource` export. The default
 * export is tried first, then named exports in declaration order. Each candidate is
 * awaited, so a module exporting `Promise<DataSource>` works too (the TypeORM CLI
 * convention).
 *
 * @throws {CliError} if the path is a `.ts` file Node can't import (no TS loader),
 *   if Node's native type-stripping loaded the `.ts` file but couldn't resolve one
 *   of its `.js`-suffixed sibling imports, or if the module exports no `DataSource`.
 */
export async function loadDataSource(modulePath: string): Promise<DataSource> {
  const url = pathToFileURL(resolve(modulePath)).href;

  let mod: Record<string, unknown>;
  try {
    mod = (await import(url)) as Record<string, unknown>;
  } catch (error) {
    throw classifyLoadError(error, modulePath) ?? error;
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
