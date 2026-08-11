import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import {
  loadDataSource,
  loadDataSourceModule,
  isDataSource,
  initializeForCli,
  classifyLoadError,
  CliError,
} from '../src/cli/index.js';

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

describe('classifyLoadError', () => {
  it('gives a TS-loader hint for ERR_UNKNOWN_FILE_EXTENSION', () => {
    const error = Object.assign(new Error('boom'), { code: 'ERR_UNKNOWN_FILE_EXTENSION' });
    const cliError = classifyLoadError(error, 'src/data-source.ts');
    expect(cliError).toBeInstanceOf(CliError);
    expect(cliError?.message).toContain('no TypeScript loader active');
  });

  // Node 22.18+ / 23.6+ imports .ts files directly (native type stripping) but does
  // not remap ".js" import specifiers to their sibling ".ts" files, which surfaces as
  // ERR_MODULE_NOT_FOUND. Verified against real Node behavior (see PR description); this
  // test only checks classification, since exercising the real import() failure inside
  // Vitest goes through Vite's own module resolution, not Node's.
  it("gives a native-type-stripping hint for ERR_MODULE_NOT_FOUND on a '.ts' DataSource", () => {
    // The classifier checks that the DataSource file itself exists, so it needs a real
    // file on disk — the failure being classified is one of its *sibling* imports.
    const path = writeModule('ds-native-strip.ts', `export default ${DS_LITERAL};`);
    const error = Object.assign(
      new Error(`Cannot find module '/proj/src/entities/Reading.js' imported from '${path}'`),
      { code: 'ERR_MODULE_NOT_FOUND' },
    );
    const cliError = classifyLoadError(error, path);
    expect(cliError).toBeInstanceOf(CliError);
    expect(cliError?.message).toContain('native type stripping');
    expect(cliError?.message).toContain('tsx');
  });

  it('does not classify ERR_MODULE_NOT_FOUND for a compiled .js DataSource (genuinely missing module)', () => {
    const error = Object.assign(new Error('Cannot find module'), { code: 'ERR_MODULE_NOT_FOUND' });
    expect(classifyLoadError(error, 'dist/data-source.js')).toBeUndefined();
  });

  it('reports "DataSource file not found" instead of a native-type-stripping hint for a typo\'d/missing -d path', () => {
    // Node throws the same ERR_MODULE_NOT_FOUND when the -d path itself doesn't exist —
    // that must not be misclassified as a native-type-stripping sibling-import failure.
    const missingPath = join(dir, 'does-not-exist.ts');
    const error = Object.assign(new Error(`Cannot find module '${missingPath}'`), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    const cliError = classifyLoadError(error, missingPath);
    expect(cliError).toBeInstanceOf(CliError);
    expect(cliError?.message).toContain('DataSource file not found');
    expect(cliError?.message).not.toContain('native type stripping');
  });

  it('does not classify ERR_MODULE_NOT_FOUND from a genuinely missing npm dependency', () => {
    // The DataSource file exists, but its own ERR_MODULE_NOT_FOUND is for a missing
    // package (no relative ".js" specifier) — this must rethrow the raw error, not
    // claim a native-type-stripping remap gap.
    const path = writeModule('ds-missing-dep.ts', `export default ${DS_LITERAL};`);
    const error = Object.assign(new Error(`Cannot find package 'pg' imported from '${path}'`), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    expect(classifyLoadError(error, path)).toBeUndefined();
  });

  it('does not classify a missing npm dependency whose package name itself ends in ".js"', () => {
    // Regression: "Cannot find package 'chart.js'" matches a bare .js-suffix regex,
    // so a .js-suffix check alone would wrongly classify this as the native-type-
    // stripping remap gap. Node's "Cannot find package" (bare specifier) vs "Cannot
    // find module" (resolved path) wording is what must discriminate the two.
    const path = writeModule('ds-missing-js-dep.ts', `export default ${DS_LITERAL};`);
    const error = Object.assign(
      new Error(`Cannot find package 'chart.js' imported from '${path}'`),
      { code: 'ERR_MODULE_NOT_FOUND' },
    );
    expect(classifyLoadError(error, path)).toBeUndefined();
  });

  it('does not classify unrelated errors', () => {
    expect(
      classifyLoadError(new Error('some other failure'), 'src/data-source.ts'),
    ).toBeUndefined();
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

// The `continuousAggregates` convention. It exists because CAGG classes are undiscoverable: their
// metadata lives in a module-private WeakMap and they are not TypeORM entities, so nothing reachable
// from the DataSource can enumerate them.
describe('loadDataSourceModule — the continuousAggregates convention', () => {
  it('returns the DataSource alone when the module has no such export', async () => {
    const path = writeModule('cagg-none.mjs', `export default ${DS_LITERAL};`);
    const loaded = await loadDataSourceModule(path);
    expect(isDataSource(loaded.dataSource)).toBe(true);
    // undefined, NOT [] — `check` distinguishes "never looked" from "declared none", and collapsing
    // them here would suppress the advisory for every project that forgets the export.
    expect(loaded.continuousAggregates).toBeUndefined();
    expect('continuousAggregates' in loaded).toBe(false);
  });

  it('picks up the named export alongside the DataSource', async () => {
    const path = writeModule(
      'cagg-some.mjs',
      `export default ${DS_LITERAL};\nclass A {}\nclass B {}\nexport const continuousAggregates = [A, B];`,
    );
    const loaded = await loadDataSourceModule(path);
    expect(loaded.continuousAggregates).toHaveLength(2);
  });

  it('preserves an explicitly EMPTY list as [] rather than undefined', async () => {
    const path = writeModule(
      'cagg-empty.mjs',
      `export default ${DS_LITERAL};\nexport const continuousAggregates = [];`,
    );
    expect((await loadDataSourceModule(path)).continuousAggregates).toEqual([]);
  });

  it('FAILS on a non-array export instead of ignoring it', async () => {
    // Ignoring it would be the worst outcome: the user believes their aggregates are checked, the
    // run compares none, and the advisory is suppressed by the export merely existing.
    const path = writeModule(
      'cagg-bad.mjs',
      `export default ${DS_LITERAL};\nexport const continuousAggregates = { nope: true };`,
    );
    await expect(loadDataSourceModule(path)).rejects.toThrow(CliError);
  });

  it('FAILS on an array containing a non-class entry, naming the index', async () => {
    const path = writeModule(
      'cagg-bad-entry.mjs',
      `export default ${DS_LITERAL};\nclass A {}\nexport const continuousAggregates = [A, 'nope'];`,
    );
    await expect(loadDataSourceModule(path)).rejects.toThrow(/entry 1 is string/);
  });

  it('still finds the DataSource when continuousAggregates is exported first', async () => {
    const path = writeModule(
      'cagg-order.mjs',
      `class A {}\nexport const continuousAggregates = [A];\nexport const ds = ${DS_LITERAL};`,
    );
    const loaded = await loadDataSourceModule(path);
    expect(isDataSource(loaded.dataSource)).toBe(true);
    expect(loaded.continuousAggregates).toHaveLength(1);
  });
});

describe('loadDataSourceModule — an unrelated exported promise cannot hijack the CLI', () => {
  // `await candidate` ran over every export in declaration order, so a module with
  // `export const ready = somePromiseThatRejects` declared BEFORE the DataSource made every verb
  // fail with that unrelated rejection — and awaited (and consumed the rejection of) any exported
  // promise purely as a side effect of running a schema command.
  it('finds the DataSource even when an earlier export is a rejecting promise', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tsdb-load-reject-'));
    const file = join(dir, 'ds.mjs');
    writeFileSync(
      file,
      [
        "import { DataSource } from 'typeorm';",
        // Declared FIRST, and already rejected by the time the loader looks at it.
        'export const ready = Promise.reject(new Error("unrelated failure"));',
        'ready.catch(() => undefined);',
        "export default new DataSource({ type: 'postgres', entities: [] });",
      ].join('\n'),
      'utf8',
    );
    const loaded = await loadDataSourceModule(file);
    expect(loaded.dataSource).toBeDefined();
    rmSync(dir, { recursive: true, force: true });
  });
});
