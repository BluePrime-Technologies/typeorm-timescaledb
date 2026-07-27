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
      /Invalid --output/,
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
