import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { parseArgs, CliError, exitCodeForMix, type MixOutcome } from '../src/cli/index.js';

describe('mix — argument contract', () => {
  it('is a recognised command', () => {
    expect(parseArgs(['mix', '-d', 'ds.ts']).command).toBe('mix');
  });

  it('previews by default, exactly like push', () => {
    // The destructive direction stays the one you ask for. `mix` running its push half implicitly
    // would be strictly worse than `push` doing so, because the user came for a REPORT.
    const a = parseArgs(['mix', '-d', 'ds.ts']);
    expect([a.apply, a.allowDrops, a.allowRefused]).toEqual([false, false, false]);
  });

  it('accepts the push-half flags', () => {
    const a = parseArgs(['mix', '-d', 'ds.ts', '--apply', '--allow-drops', '--allow-refused']);
    expect([a.apply, a.allowDrops, a.allowRefused]).toEqual([true, true, true]);
  });

  it('still rejects those flags on verbs that cannot act on them', () => {
    // Silently ignoring them would let someone believe they had authorized something they had not.
    expect(() => parseArgs(['check', '-d', 'ds.ts', '--apply'])).toThrow(CliError);
    expect(() => parseArgs(['pull', '-d', 'ds.ts', '--allow-drops'])).toThrow(
      /only valid for 'push' or 'mix'/,
    );
  });

  it('takes the file options its pull half needs', () => {
    const a = parseArgs(['mix', '-d', 'ds.ts', '-o', 'out', '--output', 'sql', '-n', 'Adopt']);
    expect([a.outDir, a.output, a.name]).toEqual(['out', 'sql', 'Adopt']);
  });
});

describe('exitCodeForMix — a half-clean run is not clean', () => {
  it('exits 0 only when BOTH halves are clean, or the push was applied', () => {
    expect(exitCodeForMix('clean')).toBe(0);
    expect(exitCodeForMix('applied')).toBe(0);
  });

  it('exits non-zero when either half needs a human', () => {
    // The failure mode this engine keeps having to design against: reporting success because the
    // half you looked at was fine. A partial pull or unapplied drift both land here.
    expect(exitCodeForMix('attention')).toBe(2);
  });

  it('has no outcome that is neither 0 nor 2', () => {
    const all: MixOutcome[] = ['clean', 'attention', 'applied'];
    expect(all.map(exitCodeForMix).every((c) => c === 0 || c === 2)).toBe(true);
  });
});
