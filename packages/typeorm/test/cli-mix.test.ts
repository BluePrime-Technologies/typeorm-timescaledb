import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  parseArgs,
  CliError,
  exitCodeForMix,
  mixOutcome,
  type MixOutcome,
  type PullOutcome,
  type PushOutcome,
} from '../src/cli/index.js';

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

/**
 * The full outcome matrix.
 *
 * Review found two defects here that NO existing test could reach: `cli-mix.test.ts` only exercised
 * `parseArgs`/`exitCodeForMix`, and the integration test ran `mixCommand` in PREVIEW mode only — so
 * every `--apply` combination was structurally unreachable. Enumerating the matrix is what makes the
 * gap impossible to reopen, rather than adding one test for the one bug that was found.
 */
describe('mixOutcome — the full 3x4 matrix', () => {
  const PULLS: PullOutcome[] = ['nothing-to-pull', 'complete', 'partial'];
  const PUSHES: PushOutcome[] = ['no-drift', 'previewed', 'applied', 'applied-with-drift'];

  it('NEVER reports success when the pull was PARTIAL — including after a successful apply', () => {
    // The must-fix. A partial pull means the code does not yet describe the database; converging
    // toward it and exiting 0 is how something gets dropped in automation that trusts the code.
    for (const pushed of PUSHES) {
      const outcome = mixOutcome('partial', pushed);
      expect(exitCodeForMix(outcome)).not.toBe(0);
    }
    // ...and when it DID apply, that fact is preserved rather than flattened into 'attention'.
    expect(mixOutcome('partial', 'applied')).toBe('applied-with-attention');
  });

  it('treats a COMPLETE pull as success, not as a problem', () => {
    // The second defect: `clean` used to require `nothing-to-pull`, which only happens on a database
    // with NO TimescaleDB objects. Every real adopted database returns `complete`, so `mix` exited 2
    // always — an exit code that is always 2 carries exactly as little information as one always 0.
    expect(mixOutcome('complete', 'no-drift')).toBe('clean');
    expect(exitCodeForMix(mixOutcome('complete', 'no-drift'))).toBe(0);
  });

  it('is clean only when neither half needs a human', () => {
    expect(mixOutcome('nothing-to-pull', 'no-drift')).toBe('clean');
    expect(mixOutcome('complete', 'previewed')).toBe('attention'); // drift left unapplied
  });

  it('distinguishes a run that CHANGED the database from a pure preview', () => {
    // Previously asserted 'attention' for 'applied-with-drift' — the identical value a
    // preview-only run produces. The exit code was 2 either way so the gate was right, but
    // mixCommand's "the push was applied, but…" warning is gated on 'applied-with-attention', so it
    // never printed and the report hid that statements had run. The operator reads the report to
    // decide what to do next, and "nothing happened" and "something happened and more is needed"
    // call for different next steps.
    expect(mixOutcome('complete', 'applied-with-drift')).toBe('applied-with-attention');
    expect(mixOutcome('complete', 'previewed')).not.toBe(
      mixOutcome('complete', 'applied-with-drift'),
    );
    // Still non-zero: this is a reporting fix, not a gate change.
    expect(exitCodeForMix(mixOutcome('complete', 'applied-with-drift'))).toBe(2);
  });

  it('reports a successful apply as success when the pull was not partial', () => {
    for (const pulled of ['nothing-to-pull', 'complete'] as PullOutcome[]) {
      expect(mixOutcome(pulled, 'applied')).toBe('applied');
      expect(exitCodeForMix(mixOutcome(pulled, 'applied'))).toBe(0);
    }
  });

  it('maps every reachable combination to a defined outcome and a 0-or-2 exit', () => {
    // Guards against a new PullOutcome/PushOutcome variant falling through to undefined.
    for (const pulled of PULLS) {
      for (const pushed of PUSHES) {
        const outcome = mixOutcome(pulled, pushed);
        expect(['clean', 'attention', 'applied', 'applied-with-attention']).toContain(outcome);
        expect([0, 2]).toContain(exitCodeForMix(outcome));
      }
    }
  });

  it('exits non-zero for applied-with-attention specifically', () => {
    expect(exitCodeForMix('applied-with-attention')).toBe(2);
  });
});
