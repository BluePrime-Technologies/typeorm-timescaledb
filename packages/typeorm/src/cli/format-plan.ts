import type { Operation, Plan } from '@blueprime/timescaledb-core';

/**
 * One-line, human-readable summary of a single {@link Operation} — the table/view it targets and
 * its essential fields. This never renders SQL (see `compileOperation` for that); it exists only to
 * make the `check` verb's drift preview legible without pretty-printing a full migration.
 */
function describeOperation(operation: Operation): string {
  switch (operation.kind) {
    case 'createHypertable':
      return (
        `create_hypertable(${operation.table}, time=${operation.timeColumn}` +
        (operation.chunkInterval !== undefined
          ? `, chunkInterval=${operation.chunkInterval}`
          : '') +
        ')'
      );
    case 'addColumnstorePolicy':
      return (
        `enable columnstore on ${operation.table}` +
        (operation.after !== undefined ? ` + compress after ${operation.after}` : '')
      );
    case 'addRetentionPolicy':
      return `add retention policy on ${operation.table} (drop after ${operation.dropAfter})`;
    case 'createContinuousAggregate':
      return `create continuous aggregate ${operation.view} (source ${operation.source})`;
    case 'createContinuousAggregateRaw':
      // Deliberately does NOT echo the definition: it is arbitrary SQL from the catalog and can be
      // long enough to bury the rest of the plan. The generated migration is where to read it.
      return `create continuous aggregate ${operation.view} (reproduced from the database's own definition)`;
    case 'addContinuousAggregatePolicy':
      return `add refresh policy on ${operation.view}`;
    case 'addCompressionPolicy':
      return `add compression policy on ${operation.table} (after ${operation.after})`;
    case 'alterCompressionPolicy':
      return `alter compression policy on ${operation.table}: ${operation.from} -> ${operation.to}`;
    case 'alterRetentionPolicy':
      return `alter retention policy on ${operation.table}: ${operation.from} -> ${operation.to}`;
    case 'renameHypertable':
      return `rename hypertable ${operation.from} -> ${operation.to}`;
    case 'setChunkInterval':
      return `set chunk interval on ${operation.table}: ${operation.from} -> ${operation.to}`;
    case 'alterColumnstoreConfig':
      return `alter columnstore config on ${operation.table} (segmentby/orderby)`;
    case 'removeRetentionPolicy':
      return `remove retention policy on ${operation.table}`;
    case 'removeCompressionPolicy':
      return `remove compression policy on ${operation.table}`;
    case 'decompressChunk':
      return `decompress chunk ${operation.chunk}`;
    case 'compressChunk':
      return `recompress chunk ${operation.chunk} (using the hypertable's current settings)`;
    default: {
      // Exhaustiveness: a new Operation variant without a case fails to compile here.
      const unhandled: never = operation;
      return `unknown operation: ${String((unhandled as { kind?: unknown }).kind)}`;
    }
  }
}

/**
 * Render a human-readable drift preview for the `check` CLI verb: one numbered line per
 * {@link Plan} step, tagged with its safety class, followed by the classifier's reason. Assumes at
 * least one step — the no-drift message is `reportPlan`'s concern, not this function's.
 */
export function formatPlanPreview(plan: Plan): string {
  const lines = plan.steps.map((step, i) => {
    const n = `${i + 1}`.padStart(2, ' ');
    return `  ${n}. [${step.safety}] ${describeOperation(step.operation)}\n      ${step.reason}`;
  });
  return (
    `Drift detected — ${plan.steps.length} operation(s) needed to converge to the desired schema:\n\n` +
    lines.join('\n\n')
  );
}
