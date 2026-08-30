import { describe, expect, it } from 'vitest';
import { parseArgs, CliError } from '../src/cli/index.js';

describe('parseArgs', () => {
  it('parses a command with the required -d option and defaults outDir', () => {
    const a = parseArgs(['generate', '-d', 'src/data-source.ts']);
    expect(a.command).toBe('generate');
    expect(a.dataSource).toBe('src/data-source.ts');
    expect(a.outDir).toBe('migrations');
    expect(a.name).toBeUndefined();
    expect(a.output).toBe('ts');
  });

  it('parses --output ts|sql and defaults to ts', () => {
    expect(parseArgs(['generate', '-d', 'ds.ts']).output).toBe('ts');
    expect(parseArgs(['generate', '-d', 'ds.ts', '--output', 'sql']).output).toBe('sql');
    expect(parseArgs(['generate', '-d', 'ds.ts', '--output=ts']).output).toBe('ts');
  });

  it('throws on an invalid --output value', () => {
    expect(() => parseArgs(['generate', '-d', 'ds.ts', '--output', 'json'])).toThrow(CliError);
    expect(() => parseArgs(['generate', '-d', 'ds.ts', '--output', 'json'])).toThrow(
      // Message widened from "Invalid --output" now that the value can also come from a
      // config file, where blaming a flag the user never typed would be misleading.
      /Invalid output format/,
    );
  });

  it('supports long flags, -o/-n, and --flag=value', () => {
    const a = parseArgs([
      'generate',
      '--dataSource=src/ds.ts',
      '-o',
      'db/migrations',
      '--name',
      'InitHypertables',
    ]);
    expect(a.dataSource).toBe('src/ds.ts');
    expect(a.outDir).toBe('db/migrations');
    expect(a.name).toBe('InitHypertables');
  });

  it('parses run / revert / status / check', () => {
    for (const c of ['run', 'revert', 'status', 'check'] as const) {
      expect(parseArgs([c, '-d', 'ds.ts']).command).toBe(c);
    }
  });

  it('throws on no command', () => {
    expect(() => parseArgs([])).toThrow(CliError);
  });

  it('throws on an unknown command', () => {
    expect(() => parseArgs(['migrate', '-d', 'ds.ts'])).toThrow(CliError);
  });

  it('throws when -d is missing', () => {
    expect(() => parseArgs(['generate'])).toThrow(/dataSource/);
  });

  it('throws on an unknown option', () => {
    expect(() => parseArgs(['generate', '-d', 'ds.ts', '--bogus', 'x'])).toThrow(CliError);
  });

  it('throws when an option is missing its value', () => {
    expect(() => parseArgs(['generate', '-d'])).toThrow(/requires a value/);
    expect(() => parseArgs(['generate', '--name='])).toThrow(/requires a value/);
  });
});

describe('parseArgs — file-output flags are refused on verbs that write no file', () => {
  // The safety flags already refused to be silently ignored, with the rationale that "silently
  // ignoring them would let someone believe they had authorized something they had not". The same
  // reasoning covers where output GOES: `check -o build/migrations` was accepted and dropped,
  // leaving the user believing they had configured an output location.
  it.each([
    ['-o', 'build/migrations'],
    ['--outDir', 'build/migrations'],
    ['-n', 'MyName'],
    ['--output', 'sql'],
  ])('rejects %s on check', (flag, value) => {
    expect(() => parseArgs(['check', '-d', 'ds.ts', flag, value])).toThrow(CliError);
  });

  it.each(['generate', 'pull', 'mix'])('still accepts them on %s', (verb) => {
    expect(() => parseArgs([verb, '-d', 'ds.ts', '-o', 'out', '-n', 'N'])).not.toThrow();
  });

  it('does NOT reject a value that came from the config file rather than the command line', () => {
    // A project config legitimately sets outDir for `generate`; erroring because the user then ran
    // `check` in that project would be obnoxious. The guard is about what was typed just now.
    expect(() => parseArgs(['check', '-d', 'ds.ts'], { outDir: 'migrations' })).not.toThrow();
  });
});

describe('--cagg-recreate', () => {
  it('defaults to advise', () => {
    expect(parseArgs(['check', '-d', 'ds.ts']).continuousAggregateRecreate).toBe('advise');
  });

  it.each(['advise', 'plan', 'apply'])('accepts %s', (mode) => {
    expect(
      parseArgs(['push', '-d', 'ds.ts', '--cagg-recreate', mode]).continuousAggregateRecreate,
    ).toBe(mode);
  });

  it('THROWS on a typo rather than silently meaning advise', () => {
    // Deliberately stricter than --output, which falls back to `ts`. This flag decides whether a
    // data-discarding step may be emitted, so `--cagg-recreate aply` quietly doing nothing is the
    // failure where the user believes they configured something and did not.
    expect(() => parseArgs(['push', '-d', 'ds.ts', '--cagg-recreate', 'aply'])).toThrow(
      /Unknown --cagg-recreate value/,
    );
  });
});

describe('--cagg-recreate: verbs that ignore it (#230 review)', () => {
  it.each(['generate', 'run', 'revert', 'status', 'pull'])(
    'REJECTS the flag on %s rather than silently ignoring it',
    (cmd) => {
      expect(() => parseArgs([cmd, '-d', 'ds.ts', '--cagg-recreate', 'plan'])).toThrow(
        /--cagg-recreate is not used by/,
      );
    },
  );

  it.each(['check', 'push', 'mix'])('accepts it on %s, which does consult it', (cmd) => {
    expect(
      parseArgs([cmd, '-d', 'ds.ts', '--cagg-recreate', 'plan']).continuousAggregateRecreate,
    ).toBe('plan');
  });

  it('names generate explicitly, since the docs used to claim it could show the step', () => {
    expect(() => parseArgs(['generate', '-d', 'ds.ts', '--cagg-recreate', 'plan'])).toThrow(
      /desired-state-only and never diffs/,
    );
  });
});
