import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CliError,
  CONFIG_FILENAME,
  extractConfigPath,
  findConfigFile,
  loadConfigFile,
  parseArgs,
  resolveConfig,
} from '../src/cli/index.js';

const root = mkdtempSync(join(tmpdir(), 'tsdb-cli-config-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
/** A fresh directory tree per case, so discovery cannot pick up a neighbour's file. */
function dir(...segments: string[]): string {
  const path = join(root, `case-${String(n++)}`, ...segments);
  mkdirSync(path, { recursive: true });
  return path;
}

function writeConfig(at: string, contents: unknown): string {
  const path = join(at, CONFIG_FILENAME);
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8');
  return path;
}

describe('findConfigFile — upward discovery', () => {
  it('finds a config in the starting directory', () => {
    const d = dir();
    const path = writeConfig(d, { dataSource: 'a.ts' });
    expect(findConfigFile(d)).toBe(path);
  });

  it('walks UP to find one in an ancestor (the monorepo case)', () => {
    // The commands are usually run from inside a package directory, not the repo root — if
    // discovery only looked at cwd the feature would miss its main use.
    const base = dir();
    const nested = join(base, 'packages', 'api', 'src');
    mkdirSync(nested, { recursive: true });
    const path = writeConfig(base, { dataSource: 'a.ts' });
    expect(findConfigFile(nested)).toBe(path);
  });

  it('stops at the FIRST hit rather than merging levels', () => {
    // Nothing is merged across levels on purpose: a silent merge of two files someone did not know
    // both existed is harder to reason about than one file that plainly wins.
    const base = dir();
    writeConfig(base, { dataSource: 'outer.ts' });
    const inner = join(base, 'pkg');
    mkdirSync(inner, { recursive: true });
    const innerPath = writeConfig(inner, { dataSource: 'inner.ts' });
    expect(findConfigFile(inner)).toBe(innerPath);
    expect(loadConfigFile(findConfigFile(inner) as string)).toEqual({ dataSource: 'inner.ts' });
  });

  it('returns undefined when no config exists anywhere up the tree', () => {
    // Reaching the filesystem root must terminate, not loop.
    expect(findConfigFile(dir())).toBeUndefined();
  });
});

describe('loadConfigFile — validation', () => {
  it('reads the recognised keys', () => {
    const d = dir();
    const path = writeConfig(d, { dataSource: 'a.ts', outDir: 'db/mig', output: 'sql' });
    expect(loadConfigFile(path)).toEqual({
      dataSource: 'a.ts',
      outDir: 'db/mig',
      output: 'sql',
    });
  });

  it('REJECTS an unknown key instead of ignoring it', () => {
    // A typo'd "datasource" that quietly does nothing is how someone runs a command against the
    // wrong DataSource while believing they configured it.
    const path = writeConfig(dir(), { datasource: 'a.ts' });
    expect(() => loadConfigFile(path)).toThrow(CliError);
    expect(() => loadConfigFile(path)).toThrow(/Unknown key "datasource"/);
  });

  it.each(['apply', 'allowDrops', 'allowRefused'])(
    'REJECTS the safety flag %s, and explains why',
    (key) => {
      // The load-bearing rule. `push` previews by default so converging is asked for per
      // invocation; a committed file that pre-authorises it for everyone who later types the
      // command is a permanent hole, not a convenience.
      const path = writeConfig(dir(), { [key]: true });
      expect(() => loadConfigFile(path)).toThrow(/not configurable/);
      expect(() => loadConfigFile(path)).toThrow(/per invocation/);
    },
  );

  it('names the file and the message on malformed JSON', () => {
    const path = writeConfig(dir(), '{ "dataSource": ');
    expect(() => loadConfigFile(path)).toThrow(/Invalid JSON in .*timescaledb\.config\.json/);
  });

  it('rejects a non-object root', () => {
    for (const body of ['[]', '"nope"', '42', 'null']) {
      const path = writeConfig(dir(), body);
      expect(() => loadConfigFile(path)).toThrow(/must contain a JSON object/);
    }
  });

  it('rejects a non-string value, naming the key and the actual type', () => {
    const path = writeConfig(dir(), { outDir: 42 });
    expect(() => loadConfigFile(path)).toThrow(/"outDir".*must be a string, got number/);
  });

  it('rejects prototype-polluting keys, and does not pollute Object.prototype', () => {
    // JSON.parse puts `__proto__` on the object as an OWN enumerable key (it does not invoke the
    // setter), so Object.entries sees it and the unknown-key check rejects it before the
    // plain-object accumulator is ever written to. That safety is currently a CONSEQUENCE of the
    // check order, so pin it: a future refactor that validates after assembling would otherwise
    // reopen the hole silently.
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const path = writeConfig(dir(), `{"${key}": {"polluted": true}}`);
      expect(() => loadConfigFile(path)).toThrow(/Unknown key/);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('accepts an empty object', () => {
    expect(loadConfigFile(writeConfig(dir(), {}))).toEqual({});
  });
});

describe('resolveConfig', () => {
  it('prefers an explicit --config over discovery', () => {
    const d = dir();
    writeConfig(d, { dataSource: 'discovered.ts' });
    const other = join(d, 'other.json');
    writeFileSync(other, JSON.stringify({ dataSource: 'explicit.ts' }), 'utf8');
    // resolveConfig anchors path values to the CONFIG FILE'S directory, so the same config behaves
    // identically from every cwd. loadConfigFile still returns the raw string (asserted above).
    expect(resolveConfig(['check', '--config', other], d)).toEqual({
      dataSource: join(dirname(other), 'explicit.ts'),
    });
  });

  it('ERRORS when an explicit --config does not exist', () => {
    // The user named a file and is entitled to be told it is missing, rather than silently getting
    // discovery or defaults and wondering why their settings did nothing.
    const d = dir();
    expect(() => resolveConfig(['check', '--config', join(d, 'nope.json')], d)).toThrow(
      /Config file not found/,
    );
  });

  it('returns an empty config when none is discovered — running without one is normal', () => {
    expect(resolveConfig(['check'], dir())).toEqual({});
  });

  it('supports --config=<path>', () => {
    const d = dir();
    const path = join(d, 'c.json');
    writeFileSync(path, JSON.stringify({ outDir: 'x' }), 'utf8');
    expect(resolveConfig(['check', `--config=${path}`], d)).toEqual({
      outDir: join(dirname(path), 'x'),
    });
  });
});

describe('extractConfigPath', () => {
  it('rejects --config with no value, and does not swallow the next flag as one', () => {
    expect(() => extractConfigPath(['check', '--config'])).toThrow(/requires a value/);
    expect(() => extractConfigPath(['check', '--config', '-d', 'ds.ts'])).toThrow(
      /requires a value/,
    );
    expect(() => extractConfigPath(['check', '--config='])).toThrow(/requires a value/);
  });

  it('does not mistake a --config that is another flag VALUE for a real one', () => {
    // Found by review. The pre-scan and the real parser are two readers of one grammar; without
    // arity awareness they disagree about what a token IS. `-n --config` names a migration
    // "--config" — the parser reads it as -n's value, and the pre-scan used to grab the NEXT token
    // as a config path. Both now consult the same flag tables, so they cannot drift.
    expect(extractConfigPath(['generate', '-n', '--config', '-d', 'ds.ts'])).toBeUndefined();
    expect(extractConfigPath(['generate', '-d', '--config'])).toBeUndefined();
    // ...while a genuine one is still found, before AND after another flag+value pair.
    expect(extractConfigPath(['check', '-d', 'ds.ts', '--config', 'c.json'])).toBe('c.json');
    expect(extractConfigPath(['check', '--config', 'c.json', '-d', 'ds.ts'])).toBe('c.json');
  });

  it('accepts the --config=<path> form through the REAL parser too, not just the pre-scan', () => {
    // Two reviewers independently reported this as broken, reading the parser as
    // `FLAG_ALIASES[token]`. It is `FLAG_ALIASES[flag]`, split on `=` first — so it always worked.
    // Pinned so the false positive cannot become a true one later.
    expect(extractConfigPath(['check', '--config=c.json'])).toBe('c.json');
    expect(() => parseArgs(['check', '--config=c.json'], { dataSource: 'a.ts' })).not.toThrow();
    expect(parseArgs(['check', '--config=c.json'], { dataSource: 'a.ts' }).dataSource).toBe('a.ts');
  });

  it('returns undefined when absent', () => {
    expect(extractConfigPath(['check', '-d', 'ds.ts'])).toBeUndefined();
  });
});

describe('parseArgs — precedence: CLI > config > default', () => {
  const config = { dataSource: 'cfg.ts', outDir: 'cfg-dir', output: 'sql' };

  it('takes values from the config when no flag is given', () => {
    const a = parseArgs(['generate'], config);
    expect([a.dataSource, a.outDir, a.output]).toEqual(['cfg.ts', 'cfg-dir', 'sql']);
  });

  it('lets a CLI flag override the config, per key', () => {
    const a = parseArgs(
      ['generate', '-d', 'cli.ts', '--outDir', 'cli-dir', '--output', 'ts'],
      config,
    );
    expect([a.dataSource, a.outDir, a.output]).toEqual(['cli.ts', 'cli-dir', 'ts']);
  });

  it('overrides key-by-key, not all-or-nothing', () => {
    const a = parseArgs(['generate', '-d', 'cli.ts'], config);
    expect([a.dataSource, a.outDir, a.output]).toEqual(['cli.ts', 'cfg-dir', 'sql']);
  });

  it('falls back to built-in defaults when neither supplies a value', () => {
    const a = parseArgs(['generate', '-d', 'x.ts'], {});
    expect([a.outDir, a.output]).toEqual(['migrations', 'ts']);
  });

  it('makes -d optional when the config supplies it', () => {
    // The point of the feature: the common path becomes one command.
    expect(parseArgs(['check'], { dataSource: 'cfg.ts' }).dataSource).toBe('cfg.ts');
  });

  it('still requires a dataSource from SOMEWHERE, and points at the config file', () => {
    expect(() => parseArgs(['check'], {})).toThrow(/Missing required option/);
    expect(() => parseArgs(['check'], {})).toThrow(/timescaledb\.config\.json/);
  });

  it('validates a config-supplied output the same as a flag', () => {
    // Otherwise a bad value in the file would silently fall through to the default, and the user
    // would get `ts` while their config said something else entirely.
    expect(() => parseArgs(['generate'], { dataSource: 'a.ts', output: 'yaml' })).toThrow(
      /Invalid output format: yaml/,
    );
  });

  it('behaves exactly as before when no config is passed', () => {
    // The regression that matters most: adding this must not change any existing invocation.
    expect(parseArgs(['generate', '-d', 'ds.ts'])).toEqual(
      parseArgs(['generate', '-d', 'ds.ts'], {}),
    );
    expect(() => parseArgs(['check'])).toThrow(/Missing required option/);
  });

  it('accepts --config in argv without treating it as an unknown option', () => {
    // Its VALUE is consumed earlier by resolveConfig; parseArgs only has to tolerate its presence.
    expect(parseArgs(['check', '--config', 'x.json'], { dataSource: 'a.ts' }).command).toBe(
      'check',
    );
  });

  it('never lets a config influence the three safety flags', () => {
    // Belt and braces: loadConfigFile already rejects these keys, but if one ever reached parseArgs
    // it must still have no effect. These come from argv or nowhere.
    const sneaky = { apply: true, allowDrops: true, allowRefused: true } as never;
    const a = parseArgs(['push', '-d', 'ds.ts'], sneaky);
    expect([a.apply, a.allowDrops, a.allowRefused]).toEqual([false, false, false]);
  });
});

describe('findConfigFile — the walk stops at the project root', () => {
  // The walk used to continue to the filesystem root. Because a config may set `dataSource`, and
  // the CLI imports that path (importing executes it), any timescaledb.config.json in ANY ancestor
  // directory silently chose which JavaScript the CLI ran — on every verb, including read-only
  // ones. A config four levels above the working directory was demonstrated executing arbitrary
  // code before the CLI printed anything.
  const base = mkdtempSync(join(tmpdir(), 'tsdb-cfg-boundary-'));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('does NOT read a config that sits above the project root', () => {
    writeFileSync(join(base, 'timescaledb.config.json'), '{"dataSource":"pwned.mjs"}');
    const project = join(base, 'victim');
    mkdirSync(join(project, 'deep', 'nested'), { recursive: true });
    writeFileSync(join(project, 'package.json'), '{}');
    expect(findConfigFile(join(project, 'deep', 'nested'))).toBeUndefined();
  });

  it('still finds the project-root config from a nested directory', () => {
    const project = join(base, 'ok');
    mkdirSync(join(project, 'packages', 'api', 'src'), { recursive: true });
    writeFileSync(join(project, 'package.json'), '{}');
    writeFileSync(join(project, 'timescaledb.config.json'), '{}');
    expect(findConfigFile(join(project, 'packages', 'api', 'src'))).toBe(
      join(project, 'timescaledb.config.json'),
    );
  });

  it('still lets a nearer monorepo package config win over the repo root', () => {
    const project = join(base, 'mono');
    const pkg = join(project, 'packages', 'api');
    mkdirSync(join(pkg, 'src'), { recursive: true });
    writeFileSync(join(project, 'package.json'), '{}');
    writeFileSync(join(project, 'timescaledb.config.json'), '{}');
    writeFileSync(join(pkg, 'package.json'), '{}');
    writeFileSync(join(pkg, 'timescaledb.config.json'), '{}');
    expect(findConfigFile(join(pkg, 'src'))).toBe(join(pkg, 'timescaledb.config.json'));
  });
});

describe('resolveConfig — path values are anchored to the config file and contained', () => {
  const base = mkdtempSync(join(tmpdir(), 'tsdb-cfg-paths-'));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('resolves a relative dataSource against the CONFIG file, not the cwd', () => {
    // A repo-root config saying "src/data-source.ts" worked from the repo root and broke from
    // <repo>/packages/app — precisely the monorepo case the upward walk exists to serve. From a deep
    // subdirectory it resolved somewhere the config author never named.
    const proj = join(base, 'anchor');
    mkdirSync(join(proj, 'packages', 'app'), { recursive: true });
    writeFileSync(join(proj, 'package.json'), '{}');
    writeFileSync(
      join(proj, 'timescaledb.config.json'),
      JSON.stringify({ dataSource: 'src/data-source.ts' }),
    );
    expect(resolveConfig([], join(proj, 'packages', 'app')).dataSource).toBe(
      join(proj, 'src', 'data-source.ts'),
    );
  });

  it('refuses an outDir that escapes the project', () => {
    // outDir went straight to mkdirSync(recursive) and a write, so a config could have a schema
    // command create directories and drop files anywhere on the filesystem.
    const proj = join(base, 'escape');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 'package.json'), '{}');
    writeFileSync(
      join(proj, 'timescaledb.config.json'),
      JSON.stringify({ outDir: '../../../../evil' }),
    );
    expect(() => resolveConfig([], proj)).toThrow(/resolves outside the project/);
  });

  it('still accepts an in-project outDir', () => {
    const proj = join(base, 'inproject');
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, 'package.json'), '{}');
    writeFileSync(join(proj, 'timescaledb.config.json'), JSON.stringify({ outDir: 'migrations' }));
    expect(resolveConfig([], proj).outDir).toBe(join(proj, 'migrations'));
  });
});
