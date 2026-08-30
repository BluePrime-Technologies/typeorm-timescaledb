import type { TimescaleConfig } from './config.js';

/**
 * The config file name. Declared HERE, not in `config.ts`, so the value dependency runs one way
 * only: `config.ts` imports this and `CliError` from `args.ts`, while `args.ts` imports just the
 * TYPE back — and a type import is erased at runtime, so the two modules never form a cycle.
 */
export const CONFIG_FILENAME = 'timescaledb.config.json';

/** The CLI subcommands. */
export const COMMANDS = [
  'generate',
  'run',
  'revert',
  'status',
  'check',
  'push',
  'pull',
  'mix',
] as const;
export type Command = (typeof COMMANDS)[number];

/** Thrown on malformed CLI input; carries a user-facing message (with usage). */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

/** Migration emit formats for `generate`: a TypeORM TS class or a raw `.sql` artifact. */
export const OUTPUT_FORMATS = ['ts', 'sql'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** How `push`/`check` handle a continuous aggregate whose definition has drifted. */
export const CAGG_RECREATE_MODES = ['advise', 'plan', 'apply'] as const;
export type CaggRecreateMode = (typeof CAGG_RECREATE_MODES)[number];

export interface ParsedArgs {
  readonly command: Command;
  /** Path to a module exporting a `DataSource`, as a default or named export. */
  readonly dataSource: string;
  /** Output directory for `generate`. Default `migrations`. */
  readonly outDir: string;
  /** Migration name prefix for `generate`. */
  readonly name?: string;
  /**
   * `push` only: actually converge the database. Default `false` — `push` PREVIEWS the plan and
   * mutates nothing unless this is passed, so running it by accident can never change a schema.
   */
  readonly apply: boolean;
  /**
   * `push` only: opt in to the reversible policy REMOVALS the diff can emit (`DiffOptions.allowDrops`).
   * Kept separate from {@link allowRefused} on purpose — removing a background job is a different
   * risk from an operation classified `refuse-by-default`, and collapsing them into one flag would
   * let a user accept the second while only meaning to accept the first.
   */
  readonly allowDrops: boolean;
  /** `push` only: opt in to applying steps classified `refuse-by-default`. */
  readonly allowRefused: boolean;
  /**
   * `push`/`check`: what to do about a continuous aggregate whose definition has drifted.
   * `'advise'` (default) reports it, `'plan'` also SHOWS the recreate step without ever running it,
   * `'apply'` allows it to run — and only together with `--allow-refused`.
   */
  readonly continuousAggregateRecreate: CaggRecreateMode;
  /** Emit format for `generate`: `ts` (TypeORM class, default) or `sql` (raw `.sql`). */
  readonly output: OutputFormat;
}

export const USAGE = `Usage: typeorm-timescaledb <command> -d <datasource>

Commands:
  generate   Generate a TimescaleDB migration from your @Hypertable entities
  run        Apply pending migrations
  revert     Revert the last applied migration
  status     Show whether migrations are pending
  check      Diff the live DB against @Hypertable declarations; exit non-zero on drift (CI gate)
  push       Converge the live DB to your entities — PREVIEWS by default, --apply to run it
  mix        Pull what the DB has, then push what your code declares (preview by default)
  pull       Reproduce the live DB's TimescaleDB layer as a migration (read-only, brownfield adopt)

Options:
  -d, --dataSource <path>   Module exporting a DataSource, default or named
                            (required unless set in timescaledb.config.json)
      --config <path>       Config file to use (default: nearest timescaledb.config.json,
                            searched upward from the current directory)
  -o, --outDir <dir>        Output dir for 'generate'/'pull' (default: migrations)
  -n, --name <name>         Migration class-name prefix for 'generate'/'pull'
      --output <ts|sql>     Emit format for 'generate'/'pull' (default: ts)
      --apply               'push': actually converge the database (default: preview only)
      --allow-drops         'push': also apply reversible policy removals
      --allow-refused       'push': also apply steps classified refuse-by-default
      --cagg-recreate <m>   drifted continuous aggregate: advise (default) | plan | apply
                            advise = report only; plan = also SHOW the recreate step but never
                            run it; apply = allow it to run (needs --allow-refused too, and it
                            DISCARDS the aggregate's materialized rows)
                            (--allowDrops / --allowRefused are accepted too)
  -h, --help                Show this help`;

export const FLAG_ALIASES: Record<
  string,
  'dataSource' | 'outDir' | 'name' | 'output' | 'config' | 'continuousAggregateRecreate'
> = {
  '-d': 'dataSource',
  // Recognised so it is not "Unknown option". Its VALUE is consumed earlier by `resolveConfig`
  // (the config has to be loaded before this parse, since it supplies defaults to it), so the
  // value captured here is deliberately unused.
  '--config': 'config',
  '--dataSource': 'dataSource',
  '-o': 'outDir',
  '--outDir': 'outDir',
  '-n': 'name',
  '--name': 'name',
  '--output': 'output',
  '--cagg-recreate': 'continuousAggregateRecreate',
};

/** Flags that take NO value. Listing them explicitly stops the value-flag loop from consuming the
 * following token (`--apply -d ds.ts` must not read `-d` as the value of `--apply`). */
export const BOOLEAN_FLAGS: Record<string, 'apply' | 'allowDrops' | 'allowRefused'> = {
  '--apply': 'apply',
  '--allow-drops': 'allowDrops',
  '--allowDrops': 'allowDrops',
  '--allow-refused': 'allowRefused',
  '--allowRefused': 'allowRefused',
};

function isOutputFormat(value: string): value is OutputFormat {
  return (OUTPUT_FORMATS as readonly string[]).includes(value);
}

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

/**
 * Parse CLI argv (excluding `node` and the script path). Throws {@link CliError}
 * with a usage message on anything malformed.
 */
export function parseArgs(argv: readonly string[], config: TimescaleConfig = {}): ParsedArgs {
  if (argv.length === 0) {
    throw new CliError(`No command given.\n\n${USAGE}`);
  }

  const [command, ...rest] = argv;
  if (command === undefined || !isCommand(command)) {
    throw new CliError(`Unknown command: ${String(command)}\n\n${USAGE}`);
  }

  const values: {
    dataSource?: string;
    outDir?: string;
    name?: string;
    output?: string;
    continuousAggregateRecreate?: string;
  } = {};
  const flags = { apply: false, allowDrops: false, allowRefused: false };

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === undefined) continue;

    // support --flag=value
    const eq = token.indexOf('=');
    const flag = eq === -1 ? token : token.slice(0, eq);

    const boolKey = BOOLEAN_FLAGS[flag];
    if (boolKey !== undefined) {
      if (eq !== -1) {
        throw new CliError(`Option ${flag} does not take a value.\n\n${USAGE}`);
      }
      flags[boolKey] = true;
      continue;
    }

    const key = FLAG_ALIASES[flag];
    if (!key) {
      throw new CliError(`Unknown option: ${token}\n\n${USAGE}`);
    }

    let value: string | undefined;
    if (eq === -1) {
      value = rest[++i];
    } else {
      value = token.slice(eq + 1);
    }
    if (value === undefined || value.length === 0) {
      throw new CliError(`Option ${flag} requires a value.\n\n${USAGE}`);
    }
    if (key === 'config') continue; // consumed by resolveConfig before this parse ran
    values[key] = value;
  }

  // Precedence, applied identically for every key: CLI flag > config file > built-in default.
  const dataSource = values.dataSource ?? config.dataSource;
  if (dataSource === undefined) {
    throw new CliError(
      `Missing required option: -d, --dataSource\n\n` +
        `Set it once in a ${CONFIG_FILENAME} instead: { "dataSource": "src/data-source.ts" }\n\n${USAGE}`,
    );
  }

  // Validate the EFFECTIVE value, not just the flag: a bad `output` in the config file must fail
  // the same way a bad --output does, rather than silently falling through to the default.
  const output = values.output ?? config.output;
  if (output !== undefined && !isOutputFormat(output)) {
    throw new CliError(
      `Invalid output format: ${output} (expected one of: ${OUTPUT_FORMATS.join(', ')})\n\n${USAGE}`,
    );
  }

  // Guard the footgun: these only mean anything for `push`, and silently ignoring them on another
  // verb would let someone believe they had authorized (or restricted) something they had not.
  for (const [flag, on] of [
    ['--apply', flags.apply],
    ['--allow-drops', flags.allowDrops],
    ['--allow-refused', flags.allowRefused],
  ] as const) {
    if (on && command !== 'push' && command !== 'mix') {
      throw new CliError(`Option ${flag} is only valid for 'push' or 'mix'.\n\n${USAGE}`);
    }
  }

  // Same rule, same reason, for the flags that choose where output GOES. `check -o build/migrations`
  // used to be accepted and dropped, leaving the user believing they had configured an output
  // location. The safety flags already refused to be ignored; these are only less dangerous, not
  // different in kind.
  // Only what was typed on the COMMAND LINE (`values`), never what a config file supplied. A project
  // config legitimately sets `outDir` for `generate`, and erroring because the user then ran `check`
  // in that project would be obnoxious — the point is to catch a flag the user believes they just
  // gave this invocation.
  const FILE_VERBS = new Set<Command>(['generate', 'pull', 'mix']);
  for (const [flag, provided] of [
    ['-o, --outDir', values.outDir !== undefined],
    ['-n, --name', values.name !== undefined],
    ['--output', values.output !== undefined],
  ] as const) {
    if (provided && !FILE_VERBS.has(command)) {
      throw new CliError(
        `Option ${flag} is only valid for 'generate', 'pull' or 'mix'.\n\n${USAGE}`,
      );
    }
  }

  return {
    command,
    dataSource,
    outDir: values.outDir ?? config.outDir ?? 'migrations',
    apply: flags.apply,
    allowDrops: flags.allowDrops,
    allowRefused: flags.allowRefused,
    ...(values.name !== undefined && { name: values.name }),
    output: output !== undefined && isOutputFormat(output) ? output : 'ts',
    continuousAggregateRecreate: resolveCaggRecreate(
      values.continuousAggregateRecreate ?? config.continuousAggregateRecreate,
      command,
      values.continuousAggregateRecreate !== undefined,
    ),
  };
}

/**
 * Resolve `--cagg-recreate` / the config key, THROWING on an unrecognised value.
 *
 * Deliberately stricter than `--output`, which silently falls back to `ts`. This flag decides whether
 * a data-discarding step may be emitted at all, so `--cagg-recreate aply` quietly meaning "advise" is
 * the same class of failure the config loader already refuses to tolerate for a typo'd key: the user
 * believes they configured something and did not.
 */
/**
 * Verbs that actually consult `--cagg-recreate`. `generate` is NOT one of them: it is
 * desired-state-only and never introspects, so it cannot produce a recreate step under any mode.
 */
const CAGG_RECREATE_COMMANDS = ['check', 'push', 'mix'] as const;

function resolveCaggRecreate(
  value: string | undefined,
  command: Command,
  fromFlag: boolean,
): CaggRecreateMode {
  // Reject the FLAG on a verb that ignores it. Accepting `generate --cagg-recreate plan` and
  // quietly doing nothing is the same silent-drop this flag's throw-on-typo already refuses; the
  // docs even claimed `generate` would show the step, which it never could.
  //
  // Only the flag is rejected, not the config key: a repo-level `timescaledb.config.json` setting
  // applies to whichever verb you happen to run, and erroring on `status` because the file sets a
  // push-related default would make the file unusable.
  if (fromFlag && !(CAGG_RECREATE_COMMANDS as readonly string[]).includes(command)) {
    throw new CliError(
      `--cagg-recreate is not used by \`${command}\` (only ${CAGG_RECREATE_COMMANDS.join(', ')} ` +
        `consult it). \`generate\` in particular is desired-state-only and never diffs against the ` +
        `database, so it cannot show a recreate step under any mode.`,
    );
  }
  if (value === undefined) return 'advise';
  if ((CAGG_RECREATE_MODES as readonly string[]).includes(value)) {
    return value as CaggRecreateMode;
  }
  throw new CliError(
    `Unknown --cagg-recreate value ${JSON.stringify(value)} ` +
      `(expected one of: ${CAGG_RECREATE_MODES.join(', ')}).`,
  );
}
