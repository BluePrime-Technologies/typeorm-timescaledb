import type { Plan } from './diff.js';
import type { Operation } from './operation.js';
import { classifyOperation } from './safety.js';

/**
 * Static analysis of a {@link Plan} — the destructive + lock linter.
 *
 * ## What this adds over the safety classes, and why it is not duplicate surface
 *
 * Every operation already carries a {@link classifyOperation} verdict, and the apply gate already
 * refuses `refuse-by-default` steps. A linter that restated those would be surface without
 * behaviour. It earns its place by covering what a PER-OPERATION classification structurally cannot:
 *
 * 1. **Plan-level interactions** — an operation targeting a table another operation renames earlier
 *    in the same plan is invisible to any single-operation check.
 * 2. **Lock characterisation** — "online-safe" does not tell an operator WHICH lock is taken or what
 *    it blocks, which is the only thing that matters when planning a deploy window.
 * 3. **Incomplete application** — several operations apply fully to future data and not at all to
 *    existing data. That is stated in prose in a safety reason; here it is a coded, queryable
 *    finding with the remedy attached.
 * 4. **Application compatibility** — a rename is safe for the DATABASE and breaks every running app
 *    still querying the old name. Nothing else in the engine looks at that.
 *
 * ## Informing vs blocking
 *
 * The linter **informs**; the safety gate **blocks**. A finding — even `error` — does not stop an
 * apply, because these describe consequences of a change the user is deliberately making. Making
 * them blocking would either make `push` unusable or train people to pass an override flag by
 * reflex, which is worse than no linter. Refusal stays with `classifyOperation` +
 * `allowRefuseByDefault`, which is one decision in one place.
 *
 * ## Scope, stated honestly
 *
 * This is the FIRST tranche, not a finished analyzer suite. The M4 plan benchmarks the eventual set
 * against Atlas's 50+; there are NINE here (TSDB005 is reserved, see below), each grounded in an operation this
 * engine actually emits.
 * The framework is the deliverable as much as the rules — new analyzers are a table entry, and
 * {@link ANALYZERS} is exported so the covered set is inspectable rather than guessed at.
 */

export type LintSeverity = 'error' | 'warning' | 'info';

export interface LintFinding {
  /** Stable identifier, safe to suppress or grep for in CI. */
  readonly code: string;
  readonly severity: LintSeverity;
  readonly title: string;
  /** What will actually happen, in concrete terms. */
  readonly detail: string;
  /** What to do about it, when there is something to do. */
  readonly remediation?: string;
  /** The object concerned (table, chunk, view). */
  readonly object?: string;
  /** Index into `plan.steps`, for tools that want to point at the step. */
  readonly step?: number;
}

/** One rule. `check` sees the operation plus the whole plan, so plan-level rules fit the same shape. */
export interface Analyzer {
  readonly code: string;
  readonly title: string;
  readonly severity: LintSeverity;
  /** Return findings for this operation. `index` is its position in `plan.steps`. */
  readonly check: (operation: Operation, index: number, plan: Plan) => LintFinding[] | null;
}

/**
 * The object an operation acts on, whatever the variant calls it.
 *
 * `renameHypertable` has `from`/`to` and NO `table`, so this returned undefined for it — and the
 * plan-level rules (which bail on an undefined target) were therefore blind to the single operation
 * the linter cares most about. It returns `from`, the name the step acts ON; the resulting name is
 * what every later step must use, and that relationship is what TSDB009 exists to check.
 */
function objectOf(operation: Operation): string | undefined {
  if (operation.kind === 'renameHypertable') return operation.from;
  const o = operation as { table?: unknown; view?: unknown; chunk?: unknown };
  for (const v of [o.table, o.view, o.chunk]) {
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/**
 * Compare two object names as RELATIONS, not strings. A plan can legitimately mix `public.metric`
 * and `metric` for one table — matching raw text made TSDB009 miss a rename whenever the two steps
 * happened to spell it differently, which is the quietest possible way for a lint rule to fail.
 */
function sameObject(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const q = (n: string): string => (n.includes('.') ? n : `public.${n}`);
  return q(a) === q(b);
}

function finding(
  a: Analyzer,
  operation: Operation,
  index: number,
  detail: string,
  remediation?: string,
): LintFinding {
  const object = objectOf(operation);
  return {
    code: a.code,
    severity: a.severity,
    title: a.title,
    detail,
    ...(remediation !== undefined && { remediation }),
    ...(object !== undefined && { object }),
    step: index,
  };
}

/**
 * The analyzer set. Exported so consumers can see exactly what IS and IS NOT covered — an analyzer
 * suite whose contents are opaque invites people to assume a check exists that does not.
 */
export const ANALYZERS: readonly Analyzer[] = [
  {
    code: 'TSDB001',
    title: 'Operation is refused by default',
    severity: 'error',
    check: (operation, index) => {
      const { safety, reason } = classifyOperation(operation);
      return safety === 'refuse-by-default'
        ? [
            finding(
              byCode('TSDB001'),
              operation,
              index,
              `This step is classified refuse-by-default: ${reason}`,
              'It will not run unless you explicitly opt in (--allow-refused / allowRefuseByDefault). Be sure you have read what it does.',
            ),
          ]
        : null;
    },
  },
  {
    code: 'TSDB002',
    title: 'Rename breaks clients still using the old name',
    severity: 'error',
    check: (operation, index) =>
      operation.kind === 'renameHypertable'
        ? [
            finding(
              byCode('TSDB002'),
              operation,
              index,
              `${operation.from} becomes ${operation.to}. The rename takes an ACCESS EXCLUSIVE lock (brief, but it blocks reads AND writes), and every query, view, or application still referencing ${operation.from} fails immediately afterwards.`,
              'Deploy the application change that uses the new name in the same window, or add a view under the old name first.',
            ),
          ]
        : null,
  },
  {
    code: 'TSDB003',
    title: 'Columnstore change does not touch existing chunks',
    severity: 'warning',
    check: (operation, index) =>
      operation.kind === 'alterColumnstoreConfig'
        ? [
            finding(
              byCode('TSDB003'),
              operation,
              index,
              `The new segmentby/orderby applies to chunks compressed AFTER this runs. Chunks already compressed keep the old layout, and the catalog will report the new setting either way — so a later drift check will look clean while the stored data does not match.`,
              'Run planRecompression()/applyRecompression() to rewrite the affected chunks. It is IO-heavy and resumable.',
            ),
          ]
        : null,
  },
  {
    code: 'TSDB004',
    title: 'Chunk interval change applies to future chunks only',
    severity: 'info',
    check: (operation, index) =>
      operation.kind === 'setChunkInterval'
        ? [
            finding(
              byCode('TSDB004'),
              operation,
              index,
              `Chunks created from now on use ${operation.to}; existing chunks keep ${operation.from}. The hypertable will hold a mix of both, which is supported and expected.`,
              'If uniform sizing matters, existing data has to be moved deliberately — there is no in-place re-chunking.',
            ),
          ]
        : null,
  },
  // TSDB005 is RESERVED for the chunk-rewrite analyzer (compressChunk / decompressChunk). Those
  // operations arrive with the recompression planner (#195); this slice branched before it, so the
  // rule lands with that merge. The code is deliberately not reused — a lint code that means two
  // different things across versions is worse than a gap in the sequence.
  {
    code: 'TSDB006',
    title: 'Removing a retention policy stops data being aged out',
    severity: 'warning',
    check: (operation, index) =>
      operation.kind === 'removeRetentionPolicy'
        ? [
            finding(
              byCode('TSDB006'),
              operation,
              index,
              `Nothing is deleted by this step, and it is reversible — but from now on ${operation.table} grows without bound. On a high-ingest hypertable that becomes a disk-space incident rather than a schema one.`,
              'Confirm this is intended, and that disk headroom is monitored.',
            ),
          ]
        : null,
  },
  {
    code: 'TSDB007',
    title: 'Removing a compression policy stops new chunks being compressed',
    severity: 'warning',
    check: (operation, index) =>
      operation.kind === 'removeCompressionPolicy'
        ? [
            finding(
              byCode('TSDB007'),
              operation,
              index,
              `Already-compressed chunks stay compressed; new ones will not be. Storage growth changes shape from this point on, silently.`,
              'Confirm this is intended rather than a decorator that was dropped by accident.',
            ),
          ]
        : null,
  },
  {
    code: 'TSDB008',
    title: 'Enabling the columnstore will rewrite existing chunks when the policy first runs',
    severity: 'info',
    check: (operation, index) =>
      operation.kind === 'addColumnstorePolicy' && operation.after !== undefined
        ? [
            finding(
              byCode('TSDB008'),
              operation,
              index,
              `The ALTER is online, but the first policy run compresses every eligible existing chunk. On a hypertable with history that is a large, one-off IO burst.`,
              'Expect the first run to be long. It is a background job, so it will not block the migration.',
            ),
          ]
        : null,
  },
  {
    code: 'TSDB009',
    title: 'Step targets a name renamed earlier in this same plan',
    severity: 'error',
    check: (operation, index, plan) => {
      const target = objectOf(operation);
      if (target === undefined || operation.kind === 'renameHypertable') return null;
      // Only renames BEFORE this step matter: by the time this runs, the old name is gone.
      const renamedAway = plan.steps
        .slice(0, index)
        .map((s) => s.operation)
        .find((o) => o.kind === 'renameHypertable' && sameObject(o.from, target));
      return renamedAway === undefined
        ? null
        : [
            finding(
              byCode('TSDB009'),
              operation,
              index,
              `This step targets ${target}, which step ${String(plan.steps.findIndex((s) => s.operation === renamedAway))} renames away. By the time it runs, that name no longer exists and the statement will fail.`,
              'Reorder so this runs before the rename, or target the new name.',
            ),
          ];
    },
  },
  {
    code: 'TSDB010',
    title: 'Plan touches the same object more than once',
    severity: 'info',
    check: (operation, index, plan) => {
      const target = objectOf(operation);
      if (target === undefined) return null;
      // Report once, on the FIRST step for that object, rather than N times.
      const firstIndex = plan.steps.findIndex((s) => sameObject(objectOf(s.operation), target));
      if (firstIndex !== index) return null;
      const count = plan.steps.filter((s) => sameObject(objectOf(s.operation), target)).length;
      return count < 2
        ? null
        : [
            finding(
              byCode('TSDB010'),
              operation,
              index,
              `${String(count)} steps in this plan target ${target}. That is normal for a full setup, but worth a glance if you expected one change.`,
            ),
          ];
    },
  },
];

/**
 * Look an analyzer up by code rather than array position. Positional access (`ANALYZERS[4]`) breaks
 * silently the moment a rule is inserted or removed — and one was removed here, which is exactly
 * how a finding ends up reported under another rule's title.
 */
function byCode(code: string): Analyzer {
  const found = ANALYZERS.find((a) => a.code === code);
  if (found === undefined) throw new Error(`unknown analyzer code: ${code}`);
  return found;
}

const SEVERITY_ORDER: Record<LintSeverity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Run every analyzer over a plan. Pure: no database, no IO — it reads the plan and nothing else,
 * which is what makes it usable in CI on a plan captured elsewhere.
 *
 * Findings come back most-severe first, then in step order, so the output reads top-down.
 */
export function lintPlan(plan: Plan): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const [index, step] of plan.steps.entries()) {
    for (const analyzer of ANALYZERS) {
      const result = analyzer.check(step.operation, index, plan);
      if (result !== null) findings.push(...result);
    }
  }
  return findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.step ?? 0) - (b.step ?? 0),
  );
}

/** Human-readable rendering, kept beside the rules so a CLI does not have to invent one. */
export function formatLintFindings(findings: readonly LintFinding[]): string {
  if (findings.length === 0) return 'No lint findings.';
  const icon: Record<LintSeverity, string> = { error: '✖', warning: '⚠', info: 'ℹ' };
  const lines: string[] = [];
  for (const f of findings) {
    lines.push(`${icon[f.severity]} ${f.code} ${f.title}${f.object ? ` — ${f.object}` : ''}`);
    lines.push(`    ${f.detail}`);
    if (f.remediation !== undefined) lines.push(`    → ${f.remediation}`);
  }
  // Say plainly that findings do not block, so nobody reads a clean lint as an approval to apply,
  // or an `error` as something that stopped the run.
  lines.push(
    '\nLint findings describe consequences; they do not block. Refusal is the safety gate’s job (--allow-refused).',
  );
  return lines.join('\n');
}
