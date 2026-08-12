import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { CliError, CONFIG_FILENAME, FLAG_ALIASES, BOOLEAN_FLAGS } from './args.js';

// CONFIG_FILENAME is declared in args.ts and re-exported here so `config.ts` is the one import
// site for config concerns. See the note on its declaration for why it lives there.
export { CONFIG_FILENAME };

/**
 * The options a config file may set: the non-safety ones, and ONLY those.
 *
 * Note what is absent — `apply`, `allowDrops`, `allowRefused`. That is the load-bearing decision of
 * this feature, not an oversight; see {@link SAFETY_KEYS}.
 *
 * Also absent: `continuousAggregates`. It is a list of CLASS references, which JSON cannot hold — a
 * config could only carry a module path, which just relocates the DataSource-module export
 * convention behind an indirection. The named export is the right shape for it.
 */
export interface TimescaleConfig {
  /** Module exporting a DataSource — the `-d` default. */
  readonly dataSource?: string;
  /** Output directory for `generate`. */
  readonly outDir?: string;
  /** Emit format for `generate`: `ts` or `sql`. */
  readonly output?: string;
}

const CONFIG_KEYS = ['dataSource', 'outDir', 'output'] as const;

/**
 * Options a config file must NEVER set.
 *
 * `push` previews by default so that converging a database is something you ask for **per
 * invocation, in the shell**. A file committed to the repo pre-authorises it for everyone who runs
 * the command afterwards — including people who never read the file, on a database it was not
 * written for. That is not a convenience, it is a permanent hole in the one property this engine
 * has spent four milestones protecting.
 *
 * So these are rejected LOUDLY rather than ignored: someone who wrote `"apply": true` believes they
 * configured something, and silently dropping it would leave them equally wrong in the other
 * direction.
 */
const SAFETY_KEYS = ['apply', 'allowDrops', 'allowRefused'] as const;

/**
 * Find the nearest {@link CONFIG_FILENAME}, walking UP from `startDir` — but never past the
 * PROJECT ROOT.
 *
 * Walking up (rather than checking only cwd) is what makes it work from inside a monorepo package
 * directory, which is where these commands are usually run. First hit wins — nothing is merged
 * across levels, because a silent merge of two files someone did not know both existed is harder to
 * reason about than one file that plainly wins.
 *
 * The walk used to continue to the filesystem root, and that was a remote-code-execution hole. A
 * config file may set `dataSource`, which the CLI passes to `loadDataSourceModule` — and importing
 * a module executes it. So a `timescaledb.config.json` in ANY ancestor directory (a shared parent,
 * $HOME, /tmp, /) silently chose which JavaScript the CLI ran, on every verb including the
 * read-only ones. Demonstrated: a config four levels above the working directory executed an
 * arbitrary script before the CLI printed anything about what it had loaded.
 *
 * The boundary is the first directory containing a `package.json` or a `.git` — i.e. the project
 * you are actually in. A monorepo package still finds the repo-root config, because the walk stops
 * AT the marker directory inclusive, and both the package and the repo root carry a marker. What it
 * will no longer do is read a file belonging to nobody's project.
 */
const PROJECT_ROOT_MARKERS = ['package.json', '.git'] as const;

export function findConfigFile(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    // Stop AFTER checking a project-root directory, so the root's own config still wins, but
    // nothing above the project is ever consulted.
    if (PROJECT_ROOT_MARKERS.some((marker) => existsSync(join(dir, marker)))) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined; // reached the filesystem root
    dir = parent;
  }
}

/**
 * Read and validate a config file.
 *
 * JSON rather than `.ts`/`.js`: a TypeScript config would need a loader, and the CLI already cannot
 * import a `.ts` DataSource without one — Node has no TS loader active in the very project this
 * library was built for. A config file that cannot be read where it is most needed is worse than
 * no config file.
 *
 * @throws {CliError} on unreadable/malformed JSON, a non-object root, an unknown key, a non-string
 *   value, or an attempt to set a safety flag.
 */
export function loadConfigFile(path: string): TimescaleConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new CliError(`Could not read config file: ${path}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliError(
      `Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliError(`Config file ${path} must contain a JSON object.`);
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  const config: Record<string, string> = {};

  for (const [key, value] of entries) {
    if ((SAFETY_KEYS as readonly string[]).includes(key)) {
      throw new CliError(
        `Config file ${path} sets "${key}", which is not configurable.\n\n` +
          `--apply, --allow-drops and --allow-refused can only be passed on the command line, ` +
          `per invocation. A config file committed to the repository would pre-authorise a ` +
          `destructive run for everyone who later types the command — including on a database it ` +
          `was never written for. Pass the flag explicitly when you mean it.`,
      );
    }
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      // Rejected rather than ignored: a typo'd "datasource" that quietly does nothing is how
      // someone runs a command against the wrong DataSource while believing they configured it.
      throw new CliError(
        `Unknown key "${key}" in ${path} (expected one of: ${CONFIG_KEYS.join(', ')}).`,
      );
    }
    if (typeof value !== 'string') {
      throw new CliError(`Config key "${key}" in ${path} must be a string, got ${typeof value}.`);
    }
    config[key] = value;
  }

  return config as TimescaleConfig;
}

/**
 * Resolve the config for a run: the file named by `--config` if present, else the nearest discovered
 * one, else nothing.
 *
 * An EXPLICIT `--config` that does not exist is an error — the user named a file and is entitled to
 * be told it is not there, rather than silently getting discovery or defaults. A *discovered* config
 * simply being absent is not an error; running without one is the normal case.
 */
/**
 * Path-valued keys in the config file. A relative value for one of these is resolved against the
 * CONFIG FILE'S directory, not the process cwd.
 *
 * Why: a config at `<repo>/timescaledb.config.json` saying `{ "dataSource": "src/data-source.ts" }`
 * worked from the repo root and broke from `<repo>/packages/app` — precisely the monorepo case the
 * upward walk exists to serve. Worse, from a deep subdirectory the relative path resolved somewhere
 * the config author never named. A path written in a file means "relative to that file"; that is the
 * only reading under which the same config behaves identically from every directory.
 */
const PATH_KEYS = ['dataSource', 'outDir'] as const;

export function resolveConfig(argv: readonly string[], cwd: string): TimescaleConfig {
  const explicit = extractConfigPath(argv);
  if (explicit !== undefined) {
    const path = resolve(cwd, explicit);
    if (!existsSync(path)) throw new CliError(`Config file not found: ${path}`);
    return anchorPaths(loadConfigFile(path), dirname(path));
  }
  const found = findConfigFile(cwd);
  return found === undefined ? {} : anchorPaths(loadConfigFile(found), dirname(found));
}

/**
 * Resolve a config's relative path values against `configDir`, and refuse one that escapes the
 * project.
 *
 * `outDir` was previously handed straight to `mkdirSync(dir, { recursive: true })` and a write, so a
 * config saying `"outDir": "../../../../../Users/x/Library/LaunchAgents"` had `generate`/`pull`
 * create that directory and drop a file into it. The filename is machine-generated, so this is not
 * arbitrary content — but creating directories and writing files outside the project is not
 * something a schema command should be able to be told to do by a file it merely found.
 */
function anchorPaths(config: TimescaleConfig, configDir: string): TimescaleConfig {
  const out: Record<string, unknown> = { ...config };
  for (const key of PATH_KEYS) {
    const value = out[key];
    if (typeof value !== 'string' || value.length === 0) continue;
    const absolute = resolve(configDir, value);
    const contained = absolute === configDir || absolute.startsWith(configDir + sep);
    if (!contained) {
      throw new CliError(
        `Config key "${key}" resolves outside the project: ${value} → ${absolute}\n\n` +
          `Paths in ${CONFIG_FILENAME} are resolved relative to that file and must stay inside its ` +
          `directory. Pass an explicit --${key === 'dataSource' ? 'dataSource' : 'outDir'} on the ` +
          `command line if you genuinely mean a path outside the project.`,
      );
    }
    out[key] = absolute;
  }
  return out as TimescaleConfig;
}

/**
 * Minimal pre-scan for `--config <path>` / `--config=<path>`.
 *
 * A pre-scan is needed because the config supplies DEFAULTS to the full parse (a config-provided
 * `dataSource` has to satisfy the required-option check), so it must be loaded before that parse
 * runs. Deliberately does not validate the rest of argv — `parseArgs` owns that, and duplicating it
 * here would create two places for the grammar to drift.
 */
export function extractConfigPath(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;

    // Skip the VALUE of any other value-taking flag, using the same tables the real parser uses.
    // Without this the pre-scan has no notion of arity, so `-n --config` (naming a migration
    // "--config") made it grab the following token as a config path — two parsers disagreeing about
    // what a token IS, which is the classic bug in this shape. Sharing the tables means they cannot
    // drift apart rather than merely happening to agree today.
    const eq = token.indexOf('=');
    const flag = eq === -1 ? token : token.slice(0, eq);
    if (flag !== '--config' && FLAG_ALIASES[flag] !== undefined && eq === -1) {
      i++; // consume its value
      continue;
    }
    if (BOOLEAN_FLAGS[flag] !== undefined) continue;

    if (token === '--config') {
      const value = argv[i + 1];
      if (value === undefined || value.length === 0 || value.startsWith('-')) {
        throw new CliError('Option --config requires a value.');
      }
      return value;
    }
    if (token.startsWith('--config=')) {
      const value = token.slice('--config='.length);
      if (value.length === 0) throw new CliError('Option --config requires a value.');
      return value;
    }
  }
  return undefined;
}
