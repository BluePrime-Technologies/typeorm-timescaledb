import { describe, expect, it } from 'vitest';
import {
  compileOperations,
  compilePlan,
  diffSchemaState,
  isEmptyPlan,
  TimescaleError,
  type Operation,
  type Plan,
  type SchemaStateIR,
  type HypertableState,
} from '../src/index.js';

// Build a SchemaStateIR from hypertable states (CAGGs are out of scope for the diff slice).
const ir = (...hypertables: HypertableState[]): SchemaStateIR => ({
  hypertables,
  continuousAggregates: [],
});

// The plan is now a list of {operation, safety, reason} steps; most assertions care about the operations.
const ops = (plan: Plan): Operation[] => plan.steps.map((s) => s.operation);

// A fully-configured hypertable: time+space dims, columnstore, compression + retention policies.
const metric = (): HypertableState => ({
  table: 'public.metric',
  dimensions: [
    { column: 'ts', kind: 'time', chunkInterval: '1 day' },
    { column: 'device_id', kind: 'space', numPartitions: 4 },
  ],
  columnstore: {
    segmentBy: ['device_id'],
    orderBy: [{ column: 'ts', desc: true, nullsFirst: true }],
  },
  compressionPolicy: { kind: 'compression', after: '30 days' },
  retentionPolicy: { kind: 'retention', after: '365 days' },
});

// A bare hypertable: time dim only.
const events = (): HypertableState => ({
  table: 'public.events',
  dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '1 hour' }],
});

describe('diffSchemaState — additive (create-only) plan', () => {
  it('emits the full create sequence for a hypertable missing from current', () => {
    const plan = diffSchemaState(ir(), ir(metric()));
    expect(ops(plan)).toEqual([
      {
        kind: 'createHypertable',
        table: 'public.metric',
        timeColumn: 'ts',
        chunkInterval: '1 day',
        spacePartition: { column: 'device_id', partitions: 4 },
      },
      {
        kind: 'addColumnstorePolicy',
        table: 'public.metric',
        segmentBy: ['device_id'],
        orderBy: [{ column: 'ts', direction: 'DESC' }],
        after: '30 days',
      },
      { kind: 'addRetentionPolicy', table: 'public.metric', dropAfter: '365 days' },
    ]);
  });

  it('emits create_hypertable only (no columnstore/policy) for a bare hypertable', () => {
    const plan = diffSchemaState(ir(), ir(events()));
    expect(ops(plan)).toEqual([
      {
        kind: 'createHypertable',
        table: 'public.events',
        timeColumn: 'ts',
        chunkInterval: '1 hour',
      },
    ]);
  });

  it('yields an EMPTY plan when current equals desired (no false drift)', () => {
    const plan = diffSchemaState(ir(metric(), events()), ir(metric(), events()));
    expect(ops(plan)).toEqual([]);
    expect(isEmptyPlan(plan)).toBe(true);
  });

  it('adds only a retention policy that exists in desired but not current (existing table)', () => {
    const withoutRetention: HypertableState = { ...metric() };
    delete (withoutRetention as { retentionPolicy?: unknown }).retentionPolicy;
    const plan = diffSchemaState(ir(withoutRetention), ir(metric()));
    expect(ops(plan)).toEqual([
      { kind: 'addRetentionPolicy', table: 'public.metric', dropAfter: '365 days' },
    ]);
  });

  it('adds only a columnstore that exists in desired but not current (existing table)', () => {
    const bare: HypertableState = {
      table: 'public.metric',
      dimensions: metric().dimensions,
    };
    const plan = diffSchemaState(ir(bare), ir(metric()));
    // columnstore add carries the compression `after`; retention is also missing → both added.
    expect(ops(plan)).toEqual([
      {
        kind: 'addColumnstorePolicy',
        table: 'public.metric',
        segmentBy: ['device_id'],
        orderBy: [{ column: 'ts', direction: 'DESC' }],
        after: '30 days',
      },
      { kind: 'addRetentionPolicy', table: 'public.metric', dropAfter: '365 days' },
    ]);
  });

  it('does NOT emit a drop for a hypertable in current but absent from desired (additive-only)', () => {
    const plan = diffSchemaState(ir(metric(), events()), ir(metric()));
    // events is only in current → no drop emitted; metric unchanged → nothing.
    expect(ops(plan)).toEqual([]);
  });

  it('emits alterRetentionPolicy when the retention threshold changed (remove-then-add)', () => {
    // current drops after 90d, desired 365d — both present but differ → alter (from current, to desired).
    const desired = metric(); // 365 days
    const current: HypertableState = {
      ...metric(),
      retentionPolicy: { kind: 'retention', after: '90 days' },
    };
    const plan = diffSchemaState(ir(current), ir(desired));
    expect(ops(plan)).toEqual([
      { kind: 'alterRetentionPolicy', table: 'public.metric', from: '90 days', to: '365 days' },
    ]);
  });

  it('emits alterCompressionPolicy when the compression threshold changed', () => {
    const desired = metric(); // compress after 30 days
    const current: HypertableState = {
      ...metric(),
      compressionPolicy: { kind: 'compression', after: '7 days' },
    };
    const plan = diffSchemaState(ir(current), ir(desired));
    expect(ops(plan)).toEqual([
      { kind: 'alterCompressionPolicy', table: 'public.metric', from: '7 days', to: '30 days' },
    ]);
  });

  it('does NOT emit a policy alter when the threshold is only textually different (30 days == 720 hours)', () => {
    // Postgres treats these intervals as equal; the normalizer must suppress the false drift.
    const desired = metric(); // retention 365 days
    const current: HypertableState = {
      ...metric(),
      retentionPolicy: { kind: 'retention', after: '8760 hours' }, // 365 * 24
    };
    const plan = diffSchemaState(ir(current), ir(desired));
    expect(ops(plan)).toEqual([]);
  });

  it('emits setChunkInterval when the time-dimension chunk interval changed', () => {
    const desired = metric(); // chunkInterval '1 day'
    const current: HypertableState = {
      ...metric(),
      dimensions: [
        { column: 'ts', kind: 'time', chunkInterval: '7 days' },
        { column: 'device_id', kind: 'space', numPartitions: 4 },
      ],
    };
    const plan = diffSchemaState(ir(current), ir(desired));
    expect(ops(plan)).toEqual([
      { kind: 'setChunkInterval', table: 'public.metric', from: '7 days', to: '1 day' },
    ]);
  });

  it('emits setChunkInterval when current is a SUB-DAY (HH:MM:SS) introspected interval — no builder crash', () => {
    // Regression: introspect renders a sub-day chunk interval as Postgres time form '01:00:00'. The
    // op's `from` carries that; compiling it must NOT throw (the builder accepts Postgres output forms).
    const desired: HypertableState = {
      table: 'public.metric',
      dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '30 minutes' }],
    };
    const current: HypertableState = {
      table: 'public.metric',
      dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '01:00:00' }], // 1 hour, introspected form
    };
    const plan = diffSchemaState(ir(current), ir(desired));
    expect(ops(plan)).toEqual([
      { kind: 'setChunkInterval', table: 'public.metric', from: '01:00:00', to: '30 minutes' },
    ]);
    // The whole point: compiling the plan does not throw on the sub-day `from`.
    expect(() => compileOperations(ops(plan))).not.toThrow();
  });

  it('emits alterRetentionPolicy with a SUB-DAY introspected from without a builder crash', () => {
    const desired: HypertableState = {
      table: 'public.metric',
      dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '1 day' }],
      retentionPolicy: { kind: 'retention', after: '3 hours' },
    };
    const current: HypertableState = {
      table: 'public.metric',
      dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '1 day' }],
      retentionPolicy: { kind: 'retention', after: '06:00:00' }, // 6 hours, introspected form
    };
    const plan = diffSchemaState(ir(current), ir(desired));
    expect(ops(plan)).toEqual([
      { kind: 'alterRetentionPolicy', table: 'public.metric', from: '06:00:00', to: '3 hours' },
    ]);
    expect(() => compileOperations(ops(plan))).not.toThrow();
  });

  it('does NOT emit setChunkInterval when desired omits chunkInterval and current is the engine default', () => {
    // desired bare (no chunkInterval → engine default '7 days'); current introspected as '7 days'.
    // Reconciling against TIMESCALE_DEFAULTS.chunkInterval must suppress this false drift (S1 contract).
    const desired: HypertableState = {
      table: 'public.events',
      dimensions: [{ column: 'ts', kind: 'time' }],
    };
    const current: HypertableState = {
      table: 'public.events',
      dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '7 days' }],
    };
    const plan = diffSchemaState(ir(current), ir(desired));
    expect(ops(plan)).toEqual([]);
  });

  it('ignores a differing scheduleInterval when the threshold matches (no false drift)', () => {
    const desired = metric();
    const current: HypertableState = {
      ...metric(),
      retentionPolicy: { kind: 'retention', after: '365 days', scheduleInterval: '1 day' },
    };
    const plan = diffSchemaState(ir(current), ir(desired));
    expect(ops(plan)).toEqual([]);
  });

  it('processes multiple new hypertables in desired order', () => {
    const plan = diffSchemaState(ir(), ir(events(), metric()));
    const tables = ops(plan).map((o) => (o as { table: string }).table);
    // events ops first (all for events), then metric ops — desired order preserved.
    expect(tables[0]).toBe('public.events');
    expect(tables.filter((t) => t === 'public.metric').length).toBeGreaterThan(0);
    expect(tables.indexOf('public.metric')).toBeGreaterThan(tables.lastIndexOf('public.events'));
  });

  it('omits the chunk interval for a bare time dimension (uses the create default)', () => {
    const bare: HypertableState = {
      table: 'public.bare',
      dimensions: [{ column: 'ts', kind: 'time' }],
    };
    const plan = diffSchemaState(ir(), ir(bare));
    expect(ops(plan)).toEqual([
      { kind: 'createHypertable', table: 'public.bare', timeColumn: 'ts' },
    ]);
  });

  it('isEmptyPlan reflects the operation count', () => {
    expect(isEmptyPlan({ steps: [] })).toBe(true);
    expect(isEmptyPlan(diffSchemaState(ir(), ir(events())))).toBe(false);
  });

  it('tags each step with its safety class + reason', () => {
    const plan = diffSchemaState(ir(), ir(metric()));
    const byKind = new Map(plan.steps.map((s) => [s.operation.kind, s]));
    // hypertable conversion + columnstore enable are one-way; a retention policy is online-safe.
    expect(byKind.get('createHypertable')?.safety).toBe('one-way');
    expect(byKind.get('addColumnstorePolicy')?.safety).toBe('one-way');
    expect(byKind.get('addRetentionPolicy')?.safety).toBe('online-safe');
    for (const step of plan.steps) expect(step.reason.length).toBeGreaterThan(0);
  });
});

// Guard + characterization tests for the unrepresentable / deferred cases the reviews surfaced. The
// diff must THROW (not silently under-converge) on desired state the string-only builders can't emit,
// and must clearly report the one known additive gap (compression policy on an already-columnstore table).
describe('diffSchemaState — unrepresentable desired state throws (no silent false convergence)', () => {
  it('throws on an integer-time chunk interval (not expressible by the builder)', () => {
    const intTime: HypertableState = {
      table: 'public.ints',
      dimensions: [{ column: 'id', kind: 'time', chunkInterval: 1_000_000 }],
    };
    expect(() => diffSchemaState(ir(), ir(intTime))).toThrow(TimescaleError);
  });

  it('throws on an integer-time retention threshold', () => {
    const t: HypertableState = {
      table: 'public.t',
      dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '1 day' }],
      retentionPolicy: { kind: 'retention', after: 1_000_000 },
    };
    expect(() => diffSchemaState(ir(), ir(t))).toThrow(TimescaleError);
  });

  it('throws on an integer-time compression threshold', () => {
    const t: HypertableState = {
      table: 'public.t',
      dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '1 day' }],
      columnstore: { segmentBy: [], orderBy: [] },
      compressionPolicy: { kind: 'compression', after: 1_000_000 },
    };
    expect(() => diffSchemaState(ir(), ir(t))).toThrow(TimescaleError);
  });

  it('throws on a compression policy declared without a columnstore (inconsistent desired)', () => {
    const t: HypertableState = {
      table: 'public.t',
      dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '1 day' }],
      // compressionPolicy but NO columnstore — a compression policy requires an enabled columnstore.
      compressionPolicy: { kind: 'compression', after: '7 days' },
    };
    expect(() => diffSchemaState(ir(), ir(t))).toThrow(TimescaleError);
  });

  it('throws on a space dimension missing numPartitions (cannot emit add_dimension)', () => {
    const t: HypertableState = {
      table: 'public.t',
      dimensions: [
        { column: 'ts', kind: 'time', chunkInterval: '1 day' },
        { column: 'device', kind: 'space' }, // no numPartitions
      ],
    };
    expect(() => diffSchemaState(ir(), ir(t))).toThrow(TimescaleError);
  });

  it('adds a missing compression policy on an already-columnstore table (AS2 closes the gap)', () => {
    // current: columnstore enabled but NO compression policy; desired: columnstore + compression policy.
    // AS2 emits a policy-only add (no ALTER SET re-assert) — the S2 gap is now closed.
    const columnstore = {
      segmentBy: ['device_id'],
      orderBy: [{ column: 'ts', desc: true, nullsFirst: true }],
    };
    const current: HypertableState = {
      table: 'public.metric',
      dimensions: metric().dimensions,
      columnstore,
    };
    const desired: HypertableState = {
      table: 'public.metric',
      dimensions: metric().dimensions,
      columnstore,
      compressionPolicy: { kind: 'compression', after: '30 days' },
    };
    const plan = diffSchemaState(ir(current), ir(desired));
    expect(ops(plan)).toEqual([
      { kind: 'addCompressionPolicy', table: 'public.metric', after: '30 days' },
    ]);
  });
});

describe('diffSchemaState — rename resolution (renamedFrom)', () => {
  it('resolves a pure rename to a single renameHypertable op (not drop+create)', () => {
    const current = ir(events()); // table: public.events
    const desired = ir({ ...events(), table: 'public.events_v2' });
    const plan = diffSchemaState(current, desired, {
      renames: new Map([['public.events_v2', 'public.events']]),
    });
    expect(ops(plan)).toEqual([
      { kind: 'renameHypertable', from: 'public.events', to: 'public.events_v2' },
    ]);
    expect(plan.steps[0]!.safety).toBe('online-safe');
  });

  it('emits the rename FIRST, then diffs the rest against the matched (old) entry', () => {
    // current: public.metric_old with the metric() config but retention 90 days instead of 365.
    const current = ir({
      ...metric(),
      table: 'public.metric_old',
      retentionPolicy: { kind: 'retention', after: '90 days' },
    });
    const desired = ir({ ...metric(), table: 'public.metric_new' });
    const plan = diffSchemaState(current, desired, {
      renames: new Map([['public.metric_new', 'public.metric_old']]),
    });
    expect(ops(plan)).toEqual([
      { kind: 'renameHypertable', from: 'public.metric_old', to: 'public.metric_new' },
      {
        kind: 'alterRetentionPolicy',
        table: 'public.metric_new',
        from: '90 days',
        to: '365 days',
      },
    ]);
  });

  it('without a renames option, a renamed table diffs as an unrelated create (default behavior unchanged)', () => {
    const current = ir(events());
    const desired = ir({ ...events(), table: 'public.events_v2' });
    const plan = diffSchemaState(current, desired); // no options — old call shape still works
    expect(ops(plan)).toEqual([
      {
        kind: 'createHypertable',
        table: 'public.events_v2',
        timeColumn: 'ts',
        chunkInterval: '1 hour',
      },
    ]);
  });

  it('falls through to create when the rename target does not exist in current', () => {
    const current = ir(); // nothing exists yet — a stale/bogus renamedFrom
    const desired = ir({ ...events(), table: 'public.events_v2' });
    const plan = diffSchemaState(current, desired, {
      renames: new Map([['public.events_v2', 'public.events_v1']]),
    });
    expect(ops(plan)).toEqual([
      {
        kind: 'createHypertable',
        table: 'public.events_v2',
        timeColumn: 'ts',
        chunkInterval: '1 hour',
      },
    ]);
  });

  it('throws on an ambiguous rename (two desired hypertables claim the same old table)', () => {
    const current = ir(events());
    const desired = ir(
      { ...events(), table: 'public.events_a' },
      { ...events(), table: 'public.events_b' },
    );
    const plan = () =>
      diffSchemaState(current, desired, {
        renames: new Map([
          ['public.events_a', 'public.events'],
          ['public.events_b', 'public.events'],
        ]),
      });
    expect(plan).toThrow(TimescaleError);
    expect(plan).toThrow(/ambiguous rename/);
  });

  it('yields an empty plan for a rename resolved on BOTH sides (already-converged rename)', () => {
    // Once the physical rename has been applied and re-introspected, current already carries the
    // NEW name — the renames map becomes irrelevant (direct match wins) and the plan stays empty.
    const state = { ...events(), table: 'public.events_v2' };
    const plan = diffSchemaState(ir(state), ir(state), {
      renames: new Map([['public.events_v2', 'public.events']]),
    });
    expect(isEmptyPlan(plan)).toBe(true);
  });
});

describe('diffSchemaState — columnstore config alters (AS3b, needs-recompress)', () => {
  const withColumnstore = (
    segmentBy: string[],
    orderBy: { column: string; desc: boolean; nullsFirst: boolean }[],
  ): HypertableState => ({
    table: 'public.metric',
    dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '1 day' }],
    columnstore: { segmentBy, orderBy },
  });
  const tsDesc = { column: 'ts', desc: true, nullsFirst: true };

  it('emits alterColumnstoreConfig when segmentBy changed (preserving current orderBy)', () => {
    const current = withColumnstore(['device_id'], [tsDesc]);
    const desired = withColumnstore(['device_id', 'region'], [tsDesc]);
    const plan = diffSchemaState(ir(current), ir(desired));
    expect(ops(plan)).toEqual([
      {
        kind: 'alterColumnstoreConfig',
        table: 'public.metric',
        from: { segmentBy: ['device_id'], orderBy: [{ column: 'ts', direction: 'DESC' }] },
        to: { segmentBy: ['device_id', 'region'], orderBy: [{ column: 'ts', direction: 'DESC' }] },
      },
    ]);
    expect(plan.steps[0]!.safety).toBe('needs-recompress');
  });

  it('emits alterColumnstoreConfig when an explicit orderBy direction changed', () => {
    const current = withColumnstore(['device_id'], [tsDesc]);
    const desired = withColumnstore(
      ['device_id'],
      [{ column: 'ts', desc: false, nullsFirst: false }],
    );
    const plan = diffSchemaState(ir(current), ir(desired));
    expect(ops(plan)).toEqual([
      {
        kind: 'alterColumnstoreConfig',
        table: 'public.metric',
        from: { segmentBy: ['device_id'], orderBy: [{ column: 'ts', direction: 'DESC' }] },
        to: { segmentBy: ['device_id'], orderBy: [{ column: 'ts', direction: 'ASC' }] },
      },
    ]);
  });

  it('does NOT drift when desired orderBy is empty and current has the engine-default (S1 contract)', () => {
    // desired declares only segmentBy; empty orderBy means "accept the engine default" (time-DESC),
    // which introspect reads back — must not false-drift.
    const current = withColumnstore(['device_id'], [tsDesc]);
    const desired = withColumnstore(['device_id'], []);
    expect(ops(diffSchemaState(ir(current), ir(desired)))).toEqual([]);
  });

  it('does NOT drift on a NULLS-only difference (builder emits col ASC|DESC, no explicit NULLS)', () => {
    const current = withColumnstore(
      ['device_id'],
      [{ column: 'ts', desc: true, nullsFirst: true }],
    );
    const desired = withColumnstore(
      ['device_id'],
      [{ column: 'ts', desc: true, nullsFirst: false }],
    );
    expect(ops(diffSchemaState(ir(current), ir(desired)))).toEqual([]);
  });

  it('does NOT drift when columnstore config is unchanged', () => {
    const cs = withColumnstore(['device_id', 'region'], [tsDesc]);
    expect(ops(diffSchemaState(ir(cs), ir(cs)))).toEqual([]);
  });
});

describe('diffSchemaState — guarded drops (AS3c, opt-in via allowDrops)', () => {
  const noRetention = (): HypertableState => {
    const h = { ...metric() };
    delete (h as { retentionPolicy?: unknown }).retentionPolicy;
    return h;
  };

  it('does NOT emit a policy removal by default (allowDrops off)', () => {
    // current has retention, desired does not — with drops off, no removal is emitted.
    const plan = diffSchemaState(ir(metric()), ir(noRetention()));
    expect(ops(plan)).toEqual([]);
  });

  it('emits removeRetentionPolicy under allowDrops when desired dropped the retention', () => {
    const plan = diffSchemaState(ir(metric()), ir(noRetention()), { allowDrops: true });
    expect(ops(plan)).toEqual([
      { kind: 'removeRetentionPolicy', table: 'public.metric', restoreAfter: '365 days' },
    ]);
    expect(plan.steps[0]!.safety).toBe('online-safe');
  });

  it('emits removeCompressionPolicy under allowDrops when desired dropped the compression policy (columnstore stays)', () => {
    // desired keeps the columnstore but no compressionPolicy; current has one → remove it.
    const desired: HypertableState = {
      table: 'public.metric',
      dimensions: metric().dimensions,
      columnstore: {
        segmentBy: ['device_id'],
        orderBy: [{ column: 'ts', desc: true, nullsFirst: true }],
      },
      retentionPolicy: { kind: 'retention', after: '365 days' },
    };
    const plan = diffSchemaState(ir(metric()), ir(desired), { allowDrops: true });
    expect(ops(plan)).toEqual([
      { kind: 'removeCompressionPolicy', table: 'public.metric', restoreAfter: '30 days' },
    ]);
  });

  it('does NOT drop a whole hypertable present in current but absent from desired (destructive, out of scope)', () => {
    // events only in current; even with allowDrops, no hypertable drop is emitted.
    const plan = diffSchemaState(ir(metric(), events()), ir(metric()), { allowDrops: true });
    expect(ops(plan)).toEqual([]);
  });

  it('throws (fail-closed) when the current retention being removed is an integer-time threshold', () => {
    // A removal must carry a string `restoreAfter` for its `down` re-add. An integer-time policy
    // can't be expressed by the builder, so stringThreshold throws rather than emit a non-reversible
    // removal — pins the fail-closed guarantee for the DROP branch (add/alter branches are covered above).
    const intRetention: HypertableState = {
      table: 'public.metric',
      dimensions: metric().dimensions,
      retentionPolicy: { kind: 'retention', after: 1_000_000 },
    };
    const noRet: HypertableState = {
      table: 'public.metric',
      dimensions: metric().dimensions,
    };
    expect(() => diffSchemaState(ir(intRetention), ir(noRet), { allowDrops: true })).toThrow(
      TimescaleError,
    );
  });

  it('throws (fail-closed) when the current compression being removed is an integer-time threshold', () => {
    const intCompression: HypertableState = {
      table: 'public.metric',
      dimensions: metric().dimensions,
      columnstore: {
        segmentBy: ['device_id'],
        orderBy: [{ column: 'ts', desc: true, nullsFirst: true }],
      },
      compressionPolicy: { kind: 'compression', after: 1_000_000 },
    };
    const columnstoreNoPolicy: HypertableState = {
      table: 'public.metric',
      dimensions: metric().dimensions,
      columnstore: {
        segmentBy: ['device_id'],
        orderBy: [{ column: 'ts', desc: true, nullsFirst: true }],
      },
    };
    expect(() =>
      diffSchemaState(ir(intCompression), ir(columnstoreNoPolicy), { allowDrops: true }),
    ).toThrow(TimescaleError);
  });
});

describe('compilePlan — Plan → reversible up/down SQL (M4.3a bridge)', () => {
  it('returns empty up/down for an empty plan', () => {
    const compiled = compilePlan({ steps: [] });
    expect(compiled).toEqual({ up: [], down: [] });
  });

  it('concatenates up in step order and down in REVERSE step order', () => {
    // A two-step additive plan (create bare hypertable + add retention). up is step-order;
    // down is each step's own down, with the STEP sequence reversed (undo most-recent first).
    const bare: HypertableState = {
      table: 'public.metric',
      dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '1 day' }],
    };
    const withRetention: HypertableState = {
      ...bare,
      retentionPolicy: { kind: 'retention', after: '30 days' },
    };
    const plan = diffSchemaState(ir(), ir(withRetention));
    // Plan: [createHypertable, addRetentionPolicy].
    expect(plan.steps.map((s) => s.operation.kind)).toEqual([
      'createHypertable',
      'addRetentionPolicy',
    ]);

    const statements = compileOperations(plan.steps.map((s) => s.operation));
    const expectedUp = statements.flatMap((s) => s.up);
    const expectedDown = [...statements].reverse().flatMap((s) => s.down);

    const compiled = compilePlan(plan);
    expect(compiled.up).toEqual(expectedUp);
    expect(compiled.down).toEqual(expectedDown);
    // The retention (last applied) is undone first in down.
    expect(compiled.down.join('\n')).toMatch(/remove_retention_policy/);
  });

  it('composes an alter step: up = remove-then-add, down = the reverse threshold', () => {
    // A single alterRetentionPolicy — verifies compilePlan surfaces the op's own up/down verbatim.
    const current: HypertableState = {
      table: 'public.metric',
      dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '1 day' }],
      retentionPolicy: { kind: 'retention', after: '90 days' },
    };
    const desired: HypertableState = {
      ...current,
      retentionPolicy: { kind: 'retention', after: '365 days' },
    };
    const plan = diffSchemaState(ir(current), ir(desired));
    expect(plan.steps.map((s) => s.operation.kind)).toEqual(['alterRetentionPolicy']);

    const compiled = compilePlan(plan);
    const [only] = compileOperations(plan.steps.map((s) => s.operation));
    expect(compiled.up).toEqual(only!.up);
    expect(compiled.down).toEqual(only!.down);
    // up moves 90d → 365d; down moves it back.
    expect(compiled.up.join('\n')).toContain('365 days');
    expect(compiled.down.join('\n')).toContain('90 days');
  });
});

// ── Pre-release audit regressions ──────────────────────────────────────────────────────────────
// Each case below reproduces a defect found in the pre-release audit of the migration engine.

const ht = (table: string, chunkInterval?: string | number): HypertableState => ({
  table,
  dimensions: [
    { column: 'ts', kind: 'time', ...(chunkInterval !== undefined && { chunkInterval }) },
  ],
});

describe('diffSchemaState — rename resolution (audit)', () => {
  it('renames BEFORE diffing, so a desired table reusing the freed name is created, not mutated', () => {
    // The live DB has one `metrics`; the code renames it to `trades` AND declares a brand-new
    // `metrics`. Resolving renames per-entry let the reused name match the about-to-be-renamed
    // entry: the new table`s chunk interval landed on `trades` and the new `metrics` was never
    // created — both statements succeed on a real DB, so the schema diverged silently.
    const plan = diffSchemaState(
      ir(ht('public.metrics', '7 days')),
      ir(ht('public.metrics', '1 day'), ht('public.trades', '7 days')),
      { renames: new Map([['public.trades', 'public.metrics']]) },
    );
    const kinds = ops(plan).map((o) => o.kind);
    expect(kinds[0]).toBe('renameHypertable'); // rename must come first
    expect(kinds).toContain('createHypertable'); // the NEW metrics is created
    // and nothing mutates the renamed-away table's chunk interval
    expect(ops(plan).some((o) => o.kind === 'setChunkInterval')).toBe(false);
  });

  it('emits a single rename for a plain rename', () => {
    const plan = diffSchemaState(ir(ht('public.old', '1 day')), ir(ht('public.new', '1 day')), {
      renames: new Map([['public.new', 'public.old']]),
    });
    expect(ops(plan)).toEqual([{ kind: 'renameHypertable', from: 'public.old', to: 'public.new' }]);
  });

  it('treats a STALE renamedFrom (already applied) as a no-op', () => {
    const plan = diffSchemaState(ir(ht('public.new', '1 day')), ir(ht('public.new', '1 day')), {
      renames: new Map([['public.new', 'public.old']]),
    });
    expect(isEmptyPlan(plan)).toBe(true);
  });

  it('still rejects an ambiguous rename after the pre-pass re-keys the map', () => {
    // Regression guard: the pre-pass deletes the old key, so ambiguity must be judged against the
    // PRE-rename snapshot or the second claimant is silently ignored.
    expect(() =>
      diffSchemaState(
        ir(ht('public.o', '1 day')),
        ir(ht('public.x', '1 day'), ht('public.y', '1 day')),
        {
          renames: new Map([
            ['public.x', 'public.o'],
            ['public.y', 'public.o'],
          ]),
        },
      ),
    ).toThrow(TimescaleError);
  });

  it('REFUSES a mutual A↔B swap instead of quietly converging per-facet', () => {
    // A bare `ALTER TABLE ... RENAME` cannot express a swap without an intermediate name. Silently
    // diffing each table per-facet would report success while leaving the DATA unswapped.
    expect(() =>
      diffSchemaState(
        ir(ht('public.a', '1 day'), ht('public.b', '2 days')),
        ir(ht('public.a', '2 days'), ht('public.b', '1 day')),
        {
          renames: new Map([
            ['public.a', 'public.b'],
            ['public.b', 'public.a'],
          ]),
        },
      ),
    ).toThrow(/already exists in the database/);
  });
});

describe('diffSchemaState — engine-implied columnstore orderBy (audit)', () => {
  const current: HypertableState = {
    table: 'public.m',
    dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '1 day' }],
    // TimescaleDB auto-appends the time column DESC when the declared orderby omits it.
    columnstore: {
      segmentBy: ['dev'],
      orderBy: [
        { column: 'region', desc: false, nullsFirst: false },
        { column: 'ts', desc: true, nullsFirst: true },
      ],
    },
    compressionPolicy: { kind: 'compression', after: '7 days' },
  };
  const desired: HypertableState = {
    table: 'public.m',
    dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '1 day' }],
    columnstore: {
      segmentBy: ['dev'],
      orderBy: [{ column: 'region', desc: false, nullsFirst: false }],
    },
    compressionPolicy: { kind: 'compression', after: '7 days' },
  };

  it('does NOT report drift when the declared orderBy omits the time column', () => {
    // Previously this diffed non-empty forever: the proposed alter re-expanded to the same catalog
    // state, so `check` could never go green and the plan advertised a needless recompress.
    expect(isEmptyPlan(diffSchemaState(ir(current), ir(desired)))).toBe(true);
  });

  it('still detects a genuine orderBy change', () => {
    const changed: HypertableState = {
      ...desired,
      columnstore: {
        segmentBy: ['dev'],
        orderBy: [{ column: 'other', desc: false, nullsFirst: false }],
      },
    };
    expect(ops(diffSchemaState(ir(current), ir(changed))).map((o) => o.kind)).toEqual([
      'alterColumnstoreConfig',
    ]);
  });
});

describe('diffSchemaState — integer-time hypertables (audit)', () => {
  it('does not throw (or drift) when the decorator declares no chunk interval', () => {
    // introspect() reports a NUMBER for an integer-time hypertable, which the decorator surface
    // cannot express. Comparing it against the interval-time default threw and aborted the whole
    // run — for every other entity too.
    const plan = diffSchemaState(ir(ht('public.d2', 1_000_000)), ir(ht('public.d2')));
    expect(isEmptyPlan(plan)).toBe(true);
  });
});

describe('diffSchemaState — space dimensions (audit)', () => {
  const timeOnly = (): HypertableState => ht('public.s', '1 day');
  const withSpace = (numPartitions: number): HypertableState => ({
    table: 'public.s',
    dimensions: [
      { column: 'ts', kind: 'time', chunkInterval: '1 day' },
      { column: 'dev', kind: 'space', numPartitions },
    ],
  });

  it('never silently reports "no drift" for a declared-but-missing space partition', () => {
    expect(() => diffSchemaState(ir(timeOnly()), ir(withSpace(4)))).toThrow(TimescaleError);
  });

  it('surfaces a changed partition count instead of ignoring it', () => {
    expect(() => diffSchemaState(ir(withSpace(4)), ir(withSpace(8)))).toThrow(TimescaleError);
  });

  it('is a no-op when the declared space dimension matches the database', () => {
    expect(isEmptyPlan(diffSchemaState(ir(withSpace(4)), ir(withSpace(4))))).toBe(true);
  });
});

describe('diffSchemaState — policy schedule + stranded policy (audit)', () => {
  const base = (scheduleInterval?: string): HypertableState => ({
    table: 'public.m',
    dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '1 day' }],
    retentionPolicy: {
      kind: 'retention',
      after: '90 days',
      ...(scheduleInterval !== undefined && { scheduleInterval }),
    },
  });

  it('ignores scheduleInterval when the desired side does not declare one (no false drift)', () => {
    // The introspected current always carries the engine-filled default cadence.
    expect(isEmptyPlan(diffSchemaState(ir(base('12 hours')), ir(base())))).toBe(true);
  });

  it('detects a changed scheduleInterval when the desired side DOES declare one', () => {
    const plan = diffSchemaState(ir(base('12 hours')), ir(base('1 hour')));
    expect(ops(plan).map((o) => o.kind)).toEqual(['alterRetentionPolicy']);
  });

  it('emits the reversible compression-policy removal even when desired abandons the columnstore', () => {
    // Previously nothing was emitted here, stranding the policy and leaving the plan unconvergeable.
    const current: HypertableState = {
      table: 'public.m',
      dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '1 day' }],
      columnstore: { segmentBy: ['d'], orderBy: [{ column: 'ts', desc: true, nullsFirst: true }] },
      compressionPolicy: { kind: 'compression', after: '7 days' },
    };
    const desired: HypertableState = {
      table: 'public.m',
      dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '1 day' }],
    };
    const plan = diffSchemaState(ir(current), ir(desired), { allowDrops: true });
    expect(ops(plan).map((o) => o.kind)).toContain('removeCompressionPolicy');
  });
});
