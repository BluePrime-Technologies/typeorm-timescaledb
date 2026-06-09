import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { loadDataSource, isDataSource, initializeForCli, CliError } from '../src/cli/index.js';

const dir = mkdtempSync(join(tmpdir(), 'tsdb-cli-load-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const DS_LITERAL = '{ initialize() {}, runMigrations() {}, entityMetadatas: [] }';

function writeModule(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

describe('isDataSource', () => {
  it('duck-types a DataSource by its key methods/properties', () => {
    expect(isDataSource({ initialize() {}, runMigrations() {}, entityMetadatas: [] })).toBe(true);
    expect(isDataSource({ initialize() {} })).toBe(false);
    expect(isDataSource({})).toBe(false);
    expect(isDataSource(null)).toBe(false);
    expect(isDataSource('nope')).toBe(false);
  });
});

describe('loadDataSource', () => {
  it('returns the default export when it is a DataSource', async () => {
    const path = writeModule('ds-default.mjs', `export default ${DS_LITERAL};`);
    expect(isDataSource(await loadDataSource(path))).toBe(true);
  });

  it('finds a named DataSource export when there is no default', async () => {
    const path = writeModule('ds-named.mjs', `export const AppDataSource = ${DS_LITERAL};`);
    expect(isDataSource(await loadDataSource(path))).toBe(true);
  });

  it('awaits a Promise<DataSource> default export', async () => {
    const path = writeModule('ds-promise.mjs', `export default Promise.resolve(${DS_LITERAL});`);
    expect(isDataSource(await loadDataSource(path))).toBe(true);
  });

  it('throws CliError when the module exports no DataSource', async () => {
    const path = writeModule('ds-none.mjs', `export const config = { foo: 1 };`);
    await expect(loadDataSource(path)).rejects.toBeInstanceOf(CliError);
  });
});

describe('initializeForCli', () => {
  it('disables synchronize/migrationsRun/dropSchema before initializing', async () => {
    let options: Record<string, unknown> | undefined;
    let initialized = false;
    const ds = {
      isInitialized: false,
      setOptions(o: Record<string, unknown>) {
        options = o;
        return this;
      },
      async initialize() {
        initialized = true;
      },
    } as unknown as DataSource;

    await initializeForCli(ds);
    expect(options).toMatchObject({
      synchronize: false,
      migrationsRun: false,
      dropSchema: false,
      subscribers: [],
    });
    expect(initialized).toBe(true);
  });

  it('leaves an already-initialized DataSource untouched', async () => {
    let touched = false;
    const ds = {
      isInitialized: true,
      setOptions() {
        touched = true;
        return this;
      },
      async initialize() {
        touched = true;
      },
    } as unknown as DataSource;

    await initializeForCli(ds);
    expect(touched).toBe(false);
  });
});
