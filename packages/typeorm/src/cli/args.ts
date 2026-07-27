/** The CLI subcommands. */
export const COMMANDS = ['generate', 'run', 'revert', 'status', 'check'] as const;
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

export interface ParsedArgs {
  readonly command: Command;
  /** Path to a module exporting a `DataSource`, as a default or named export. */
  readonly dataSource: string;
  /** Output directory for `generate`. Default `migrations`. */
  readonly outDir: string;
  /** Migration name prefix for `generate`. */
  readonly name?: string;
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

Options:
  -d, --dataSource <path>   Module exporting a DataSource, default or named (required)
  -o, --outDir <dir>        Output dir for 'generate' (default: migrations)
  -n, --name <name>         Migration class-name prefix for 'generate'
      --output <ts|sql>     Emit format for 'generate' (default: ts)
  -h, --help                Show this help`;

const FLAG_ALIASES: Record<string, 'dataSource' | 'outDir' | 'name' | 'output'> = {
  '-d': 'dataSource',
  '--dataSource': 'dataSource',
  '-o': 'outDir',
  '--outDir': 'outDir',
  '-n': 'name',
  '--name': 'name',
  '--output': 'output',
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
export function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.length === 0) {
    throw new CliError(`No command given.\n\n${USAGE}`);
  }

  const [command, ...rest] = argv;
  if (command === undefined || !isCommand(command)) {
    throw new CliError(`Unknown command: ${String(command)}\n\n${USAGE}`);
  }

  const values: { dataSource?: string; outDir?: string; name?: string; output?: string } = {};

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === undefined) continue;

    // support --flag=value
    const eq = token.indexOf('=');
    const flag = eq === -1 ? token : token.slice(0, eq);
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
    values[key] = value;
  }

  if (values.dataSource === undefined) {
    throw new CliError(`Missing required option: -d, --dataSource\n\n${USAGE}`);
  }

  if (values.output !== undefined && !isOutputFormat(values.output)) {
    throw new CliError(
      `Invalid --output: ${values.output} (expected one of: ${OUTPUT_FORMATS.join(', ')})\n\n${USAGE}`,
    );
  }

  return {
    command,
    dataSource: values.dataSource,
    outDir: values.outDir ?? 'migrations',
    ...(values.name !== undefined && { name: values.name }),
    output: values.output !== undefined && isOutputFormat(values.output) ? values.output : 'ts',
  };
}
