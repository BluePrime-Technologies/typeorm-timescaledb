import { describe, expect, it } from 'vitest';
import {
  classifyOperation,
  compileOperations,
  compilePlan,
  diffSchemaState,
  isEmptyPlan,
  TimescaleError,
  type Operation,
  type Plan,
  type SchemaStateIR,
  type HypertableState,
  type ContinuousAggregateState,
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
describe('diffSchemaState — a changed time dimension is refused, never silently ignored', () => {
  // Regression: only `chunkInterval` was compared on an existing hypertable, so moving
  // `@TimeColumn()` to another column produced an EMPTY plan with no advisory. `check` exited
  // clean and CI went green while the table was still partitioned on the old column — chunk
  // exclusion, the implied columnstore orderby and every CAGG bucket then reasoned about a column
  // the database does not partition on. A drift gate returning "no drift" for real drift is the
  // one outcome it must never produce.
  const onTime = (column: string): HypertableState => ({
    table: 'public.metric',
    dimensions: [{ column, kind: 'time', chunkInterval: '7 days' }],
  });

  it('throws when the declared time column differs from the database', () => {
    expect(() => diffSchemaState(ir(onTime('ts')), ir(onTime('created_at')))).toThrow(
      TimescaleError,
    );
  });

  it('names both columns and the remedy, so the error is actionable', () => {
    try {
      diffSchemaState(ir(onTime('ts')), ir(onTime('created_at')));
      throw new Error('expected diffSchemaState to throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/"ts"/);
      expect(message).toMatch(/"created_at"/);
      expect(message).toMatch(/recreating the hypertable/);
    }
  });

  it('throws when desired declares no time dimension for an existing hypertable', () => {
    const noTime: HypertableState = { table: 'public.metric', dimensions: [] };
    expect(() => diffSchemaState(ir(onTime('ts')), ir(noTime))).toThrow(TimescaleError);
  });

  it('still reports an unchanged time column as no drift', () => {
    // The guard must not turn every existing hypertable into an error.
    expect(diffSchemaState(ir(onTime('ts')), ir(onTime('ts'))).steps).toEqual([]);
  });

  it('does NOT touch a chunk interval the desired state never declared', () => {
    // Regression: an undeclared chunkInterval fell back to TIMESCALE_DEFAULTS, so a hypertable at a
    // DBA-tuned 30 days, described by a decorator that says nothing about chunk sizing, produced
    // `setChunkInterval 30 days -> 7 days`. No data loss (future chunks only), but the sizing
    // silently regressed and the plan looked deliberate. Unset means unmanaged here, as it already
    // did for segmentBy/orderBy and scheduleInterval.
    const tuned: HypertableState = {
      table: 'public.metric',
      dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '30 days' }],
    };
    const undeclared: HypertableState = {
      table: 'public.metric',
      dimensions: [{ column: 'ts', kind: 'time' }],
    };
    expect(diffSchemaState(ir(tuned), ir(undeclared)).steps).toEqual([]);
  });

  it('still detects a chunk-interval change on the same column', () => {
    const wider: HypertableState = {
      table: 'public.metric',
      dimensions: [{ column: 'ts', kind: 'time', chunkInterval: '1 day' }],
    };
    const plan = diffSchemaState(ir(onTime('ts')), ir(wider));
    expect(ops(plan)).toEqual([
      { kind: 'setChunkInterval', table: 'public.metric', from: '7 days', to: '1 day' },
    ]);
  });
});

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

// ── Continuous aggregates: additive-only ─────────────────────────────────────────────────────
// The pass exists to close a false-green: before it, a @ContinuousAggregate declared in code but
// absent from the database produced "No drift detected". It must close that WITHOUT acquiring the
// power to drop or recreate an aggregate — a CAGG's materialized rows may be the only surviving copy
// of data whose source chunks retention has already dropped.
describe('diffSchemaState — continuous aggregates (additive only)', () => {
  const cagg = (over: Partial<ContinuousAggregateState> = {}): ContinuousAggregateState => ({
    viewName: 'public.metric_hourly',
    source: 'public.metric',
    hierarchical: false,
    materializedOnly: false,
    definition:
      'SELECT time_bucket(INTERVAL \'1 hour\', "ts") AS "bucket" FROM "public"."metric" GROUP BY 1',
    ...over,
  });

  const withCaggs = (...caggs: ContinuousAggregateState[]): SchemaStateIR => ({
    hypertables: [],
    continuousAggregates: caggs,
  });

  describe('an undeclared aggregate is named even when OTHER aggregates are declared', () => {
    // Regression: the current-only sweep sat behind an early return taken only when the desired
    // list was COMPLETELY empty, so declaring one aggregate silenced the advisory for every other
    // one in the database — the configuration nearly every real project is in. `check` then printed
    // "No drift detected" and exited 0 without ever naming the undeclared view.
    const declared = cagg({ viewName: 'public.declared' });
    const forgotten = cagg({ viewName: 'public.forgotten' });

    it('names the undeclared aggregate when a DIFFERENT one is declared', () => {
      const plan = diffSchemaState(withCaggs(declared, forgotten), withCaggs(declared));
      const named = (plan.advisories ?? []).map((a) => a.object);
      expect(named).toContain('public.forgotten');
    });

    it('still names every aggregate when NONE is declared', () => {
      const plan = diffSchemaState(withCaggs(declared, forgotten), withCaggs());
      const named = (plan.advisories ?? []).map((a) => a.object);
      expect(named).toEqual(expect.arrayContaining(['public.declared', 'public.forgotten']));
    });

    it('does not report a declared aggregate as undeclared', () => {
      const plan = diffSchemaState(withCaggs(declared), withCaggs(declared));
      const undeclaredNotices = (plan.advisories ?? []).filter((a) =>
        a.detail.includes('is not declared'),
      );
      expect(undeclaredNotices).toEqual([]);
    });
  });

  const refresh = {
    kind: 'refresh' as const,
    startOffset: '1 month',
    endOffset: '1 hour',
    scheduleInterval: '30 minutes',
  };

  it('creates a desired CAGG the database lacks', () => {
    const plan = diffSchemaState(withCaggs(), withCaggs(cagg()));
    expect(ops(plan)).toEqual([
      {
        kind: 'createContinuousAggregateRaw',
        view: 'public.metric_hourly',
        definition: cagg().definition,
        materializedOnly: false,
        // The diff only ever emits this for an aggregate it has established is ABSENT, so the
        // intent is always 'create' here — which is what makes down() drop it and the plan preview
        // describe it honestly.
        intent: 'create',
      },
    ]);
  });

  it('creates the CAGG and attaches its declared refresh policy, in that order', () => {
    const plan = diffSchemaState(withCaggs(), withCaggs(cagg({ refresh })));
    expect(ops(plan).map((o) => o.kind)).toEqual([
      'createContinuousAggregateRaw',
      'addContinuousAggregatePolicy',
    ]);
    expect(ops(plan)[1]).toEqual({
      kind: 'addContinuousAggregatePolicy',
      view: 'public.metric_hourly',
      startOffset: '1 month',
      endOffset: '1 hour',
      scheduleInterval: '30 minutes',
    });
  });

  it('treats an omitted offset as OPEN (null), not as a missing argument', () => {
    const plan = diffSchemaState(
      withCaggs(),
      withCaggs(cagg({ refresh: { kind: 'refresh', scheduleInterval: '1 hour' } })),
    );
    expect(ops(plan)[1]).toMatchObject({ startOffset: null, endOffset: null });
  });

  it('emits NO create for a CAGG that already exists — never recreate', () => {
    const plan = diffSchemaState(withCaggs(cagg()), withCaggs(cagg()));
    expect(ops(plan)).toEqual([]);
  });

  it('attaches a declared refresh policy to an EXISTING CAGG that has none', () => {
    const plan = diffSchemaState(withCaggs(cagg()), withCaggs(cagg({ refresh })));
    expect(ops(plan).map((o) => o.kind)).toEqual(['addContinuousAggregatePolicy']);
  });

  it('emits nothing when an existing CAGG already has the declared refresh policy', () => {
    const plan = diffSchemaState(withCaggs(cagg({ refresh })), withCaggs(cagg({ refresh })));
    expect(ops(plan)).toEqual([]);
  });

  it('does not false-drift on the catalog\'s interval rendering ("1 mon" vs "1 month")', () => {
    // The live catalog reports INTERVAL '1 month' as '1 mon' — the exact rendering that broke `pull`.
    // Comparing raw strings here would propose a policy change on an unchanged schema forever.
    const live = { ...refresh, startOffset: '1 mon' };
    const plan = diffSchemaState(withCaggs(cagg({ refresh: live })), withCaggs(cagg({ refresh })));
    expect(ops(plan)).toEqual([]);
    expect(plan.advisories?.filter((a) => a.kind === 'not-expressible')).toEqual([]);
  });

  it('ignores a scheduleInterval the desired side does not declare (engine fills a default)', () => {
    const desired = { kind: 'refresh' as const, startOffset: '1 month', endOffset: '1 hour' };
    const live = { ...desired, scheduleInterval: '17 minutes' };
    const plan = diffSchemaState(
      withCaggs(cagg({ refresh: live })),
      withCaggs(cagg({ refresh: desired })),
    );
    expect(ops(plan)).toEqual([]);
  });

  it('NEVER drops a CAGG absent from desired, even with allowDrops', () => {
    const plan = diffSchemaState(withCaggs(cagg()), withCaggs(), { allowDrops: true });
    expect(ops(plan)).toEqual([]);
    // Assert on the OPERATIONS, not on the serialized plan: the advisory text now legitimately
    // contains the word "dropped" ("It will never be dropped"), which a naive /drop/i over the
    // whole JSON matches. What must never appear is a drop OPERATION.
    expect(ops(plan).map((o) => o.kind)).toEqual([]);
    // ...and the undeclared live aggregate is still reported rather than passed over in silence.
    expect(plan.advisories).toEqual([
      expect.objectContaining({ kind: 'not-compared', object: 'public.metric_hourly' }),
    ]);
  });

  it('orders CAGG creates AFTER hypertable operations (a CAGG reads from one)', () => {
    const desired: SchemaStateIR = { hypertables: [events()], continuousAggregates: [cagg()] };
    const plan = diffSchemaState(ir(), desired);
    const kinds = ops(plan).map((o) => o.kind);
    expect(kinds[0]).toBe('createHypertable');
    expect(kinds.at(-1)).toBe('createContinuousAggregateRaw');
  });

  it('creates a hierarchical CAGG after its parent', () => {
    const parent = cagg({ viewName: 'public.hourly' });
    const child = cagg({ viewName: 'public.daily', source: 'public.hourly', hierarchical: true });
    const plan = diffSchemaState(withCaggs(), withCaggs(parent, child));
    expect(ops(plan).map((o) => (o as { view: string }).view)).toEqual([
      'public.hourly',
      'public.daily',
    ]);
  });

  it('refuses to build a plan whose hierarchical CAGG precedes the parent it reads from', () => {
    // Only reachable from a hand-built IR (the compiler sorts topologically) — but emitting anyway
    // would produce SQL that fails halfway, leaving the schema partly converged.
    const parent = cagg({ viewName: 'public.hourly' });
    const child = cagg({ viewName: 'public.daily', source: 'public.hourly', hierarchical: true });
    expect(() => diffSchemaState(withCaggs(), withCaggs(child, parent))).toThrow(
      /neither in the database nor created earlier in this plan/,
    );
  });

  it('refuses a hierarchical CAGG whose parent is declared NOWHERE — not in desired, not in the DB', () => {
    // The commonest form of this mistake by far, and the one the first version of the guard missed:
    // it only fired when the parent WAS in the desired list. Export just the child
    // (`continuousAggregates: [DailyRollup]`), forget the parent, and the create was emitted for a
    // view whose source does not exist — apply dies on "relation ... does not exist" with the
    // schema half-migrated.
    const child = cagg({ viewName: 'public.daily', source: 'public.hourly', hierarchical: true });
    expect(() => diffSchemaState(withCaggs(), withCaggs(child))).toThrow(
      /reads from public\.hourly, which is neither in the database nor created earlier/,
    );
  });

  it('reports undeclared live CAGGs when nothing is desired, instead of staying silent', () => {
    // Covers the caller who composes introspect -> compileDesiredState -> diffSchemaState by hand
    // and so never reaches pushSchema's absent-list check.
    const plan = diffSchemaState(withCaggs(cagg()), withCaggs());
    expect(ops(plan)).toEqual([]);
    expect(plan.advisories).toEqual([
      expect.objectContaining({ kind: 'not-compared', object: 'public.metric_hourly' }),
    ]);
  });

  it('says nothing when neither side has any CAGGs', () => {
    expect(diffSchemaState(withCaggs(), withCaggs()).advisories).toBeUndefined();
  });

  it('allows a hierarchical CAGG whose parent already exists in the database', () => {
    const parent = cagg({ viewName: 'public.hourly' });
    const child = cagg({ viewName: 'public.daily', source: 'public.hourly', hierarchical: true });
    const plan = diffSchemaState(withCaggs(parent), withCaggs(child));
    expect(ops(plan).map((o) => o.kind)).toEqual(['createContinuousAggregateRaw']);
  });
});

// The honesty half. A clean `check` must never imply more than the engine actually verified.
describe('diffSchemaState — CAGG advisories', () => {
  const cagg = (over: Partial<ContinuousAggregateState> = {}): ContinuousAggregateState => ({
    viewName: 'public.metric_hourly',
    source: 'public.metric',
    hierarchical: false,
    materializedOnly: false,
    definition: 'SELECT 1',
    ...over,
  });
  const withCaggs = (...caggs: ContinuousAggregateState[]): SchemaStateIR => ({
    hypertables: [],
    continuousAggregates: caggs,
  });
  const refresh = {
    kind: 'refresh' as const,
    startOffset: '1 month',
    endOffset: '1 hour',
    scheduleInterval: '30 minutes',
  };

  it('raises not-compared for an existing CAGG, since its definition is never compared', () => {
    const plan = diffSchemaState(withCaggs(cagg()), withCaggs(cagg()));
    expect(isEmptyPlan(plan)).toBe(true); // no steps...
    expect(plan.advisories).toEqual([
      {
        kind: 'not-compared',
        object: 'public.metric_hourly',
        detail: expect.stringContaining('is NOT compared'),
      },
    ]);
  });

  it('raises no advisory for a CAGG it CREATES (it matches by construction)', () => {
    const plan = diffSchemaState(withCaggs(), withCaggs(cagg()));
    expect(plan.advisories).toBeUndefined();
  });

  it('omits advisories entirely when no CAGGs are desired', () => {
    expect(diffSchemaState(ir(metric()), ir()).advisories).toBeUndefined();
  });

  it('raises not-expressible for a CHANGED refresh threshold rather than silently converging', () => {
    const live = { ...refresh, startOffset: '2 months' };
    const plan = diffSchemaState(withCaggs(cagg({ refresh: live })), withCaggs(cagg({ refresh })));
    // Altering a refresh policy has no operation yet, so nothing is emitted...
    expect(ops(plan)).toEqual([]);
    // ...but the divergence MUST be reported. Emitting nothing and saying nothing would report a
    // diverged schema as converged — the exact false-green this slice exists to close.
    const notExpressible = plan.advisories?.filter((a) => a.kind === 'not-expressible') ?? [];
    expect(notExpressible).toHaveLength(1);
    expect(notExpressible[0]?.detail).toMatch(/refresh policy differs/);
  });

  it('raises not-expressible when a non-refresh job occupies the aggregate', () => {
    const live = { kind: 'unmanaged' as const, procName: 'my_custom_job' };
    const plan = diffSchemaState(withCaggs(cagg({ refresh: live })), withCaggs(cagg({ refresh })));
    expect(ops(plan)).toEqual([]);
    expect(plan.advisories?.some((a) => a.kind === 'not-expressible')).toBe(true);
  });

  it('throws on an integer-time refresh offset instead of emitting a wrong policy', () => {
    const desired = { kind: 'refresh' as const, startOffset: 1000, scheduleInterval: '1 hour' };
    expect(() => diffSchemaState(withCaggs(), withCaggs(cagg({ refresh: desired })))).toThrow(
      /integer-time refresh start offset/,
    );
  });

  it('throws when a declared refresh policy has no schedule interval (2.18 has no such overload)', () => {
    const desired = { kind: 'refresh' as const, startOffset: '1 month' };
    expect(() => diffSchemaState(withCaggs(), withCaggs(cagg({ refresh: desired })))).toThrow(
      /needs a schedule interval/,
    );
  });
});

describe('diffSchemaState — materialized_only is reported, not silently ignored', () => {
  const base = (over: Partial<ContinuousAggregateState> = {}): ContinuousAggregateState => ({
    viewName: 'public.v',
    source: 'public.t',
    hierarchical: false,
    materializedOnly: false,
    definition: 'SELECT 1',
    ...over,
  });
  const withCaggs = (...c: ContinuousAggregateState[]): SchemaStateIR => ({
    hypertables: [],
    continuousAggregates: c,
  });

  it('raises not-expressible when materialized_only differs from the declaration', () => {
    // The plan for this slice promised "report, do not emit" for this facet. It was compiled into
    // the desired IR and read back by introspect(), then never compared — so the promise was only
    // half kept, and the blanket not-compared note does not mention it.
    const plan = diffSchemaState(
      withCaggs(base({ materializedOnly: true })),
      withCaggs(base({ materializedOnly: false })),
    );
    expect(ops(plan)).toEqual([]); // still never emitted
    const blocking = (plan.advisories ?? []).filter((a) => a.kind === 'not-expressible');
    expect(blocking).toHaveLength(1);
    expect(blocking[0]?.detail).toMatch(/materialized_only is true .* but false/);
  });

  it('stays quiet when materialized_only matches', () => {
    const plan = diffSchemaState(withCaggs(base()), withCaggs(base()));
    expect((plan.advisories ?? []).filter((a) => a.kind === 'not-expressible')).toEqual([]);
  });
});

describe('diffSchemaState — CAGG definitions are now compared structurally', () => {
  // Real server rendering vs the declared form of the SAME aggregate. Five textual divergences,
  // one aggregate — this must produce NO advisory at all, which is the whole point.
  const SERVER = ` SELECT time_bucket('01:00:00'::interval, "time") AS bucket,\n    sensor_id,\n    avg(value) AS avg_value\n   FROM sensor_reading\n  GROUP BY (time_bucket('01:00:00'::interval, "time")), sensor_id;`;
  const DECLARED =
    'SELECT time_bucket(INTERVAL \'1 hour\', "time") AS "bucket", "sensor_id", avg(value) AS "avg_value" FROM sensor_reading GROUP BY 1, 2';

  const cagg = (definition: string) => ({
    viewName: 'public.reading_hourly',
    source: 'public.sensor_reading',
    hierarchical: false,
    materializedOnly: false,
    definition,
  });
  const ir = (definition: string) => ({
    hypertables: [],
    continuousAggregates: [cagg(definition)],
  });

  it('raises NO advisory when the stored and declared definitions are the same aggregate', () => {
    const plan = diffSchemaState(ir(SERVER), ir(DECLARED));
    // Previously every existing CAGG got a blanket `not-compared`. Now an unchanged one is silent.
    expect(plan.advisories ?? []).toEqual([]);
  });

  it('raises a BLOCKING not-expressible naming the changed facet', () => {
    const widened = DECLARED.replace("INTERVAL '1 hour'", "INTERVAL '1 day'");
    const plan = diffSchemaState(ir(SERVER), ir(widened));
    const advisories = plan.advisories ?? [];
    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.kind).toBe('not-expressible'); // blocking — `check` must not exit clean
    expect(advisories[0]?.detail).toContain('bucket width');
    // It says WHAT moved, not merely that something did.
    expect(advisories[0]?.detail).toContain('us:3600000000');
    expect(advisories[0]?.detail).toContain('us:86400000000');
  });

  it('names a changed group-key set', () => {
    const regrouped =
      'SELECT time_bucket(INTERVAL \'1 hour\', "time") AS "bucket", "sensor_id", "region", avg(value) AS "avg_value" FROM sensor_reading GROUP BY 1, 2, 3';
    const plan = diffSchemaState(ir(SERVER), ir(regrouped));
    expect(plan.advisories?.[0]?.detail).toContain('group keys');
  });

  it('falls back to not-compared — never a guess — when a definition will not parse', () => {
    const exotic =
      'SELECT time_bucket(INTERVAL \'1 hour\', "time") AS "b", avg(value * 2) AS "v" FROM r GROUP BY 1';
    const plan = diffSchemaState(ir(SERVER), ir(exotic));
    expect(plan.advisories?.[0]?.kind).toBe('not-compared');
  });

  // One case per finding the review panel raised, asserted at THIS level — the layer that renders
  // the verdict a user actually sees. The four cases above each asserted a facet the code already
  // handled, so none of them could fail on an inherited defect.

  it('names a RENAMED BUCKET column instead of reporting no drift', () => {
    const renamed = DECLARED.replace('AS "bucket"', 'AS "ts_bucket"');
    const advisories = diffSchemaState(ir(SERVER), ir(renamed)).advisories ?? [];
    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.kind).toBe('not-expressible');
    expect(advisories[0]?.detail).toContain('bucket column');
  });

  it('names a RENAMED GROUPED column instead of reporting no drift', () => {
    const renamed = DECLARED.replace('"sensor_id",', '"sensor_id" AS "sid",');
    const advisories = diffSchemaState(ir(SERVER), ir(renamed)).advisories ?? [];
    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.kind).toBe('not-expressible');
    // Regression guard for `groupBy.join(',')`, which rendered "[object Object]" on BOTH sides and
    // therefore reported every group-key change as identical.
    expect(advisories[0]?.detail).toContain('group keys');
    expect(advisories[0]?.detail).not.toContain('[object Object]');
  });

  it('treats a MONTH bucket as different from a 30-day bucket', () => {
    const monthly = DECLARED.replace("INTERVAL '1 hour'", "INTERVAL '1 mon'");
    const thirtyDays = DECLARED.replace("INTERVAL '1 hour'", "INTERVAL '30 days'");
    const advisories = diffSchemaState(ir(monthly), ir(thirtyDays)).advisories ?? [];
    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.kind).toBe('not-expressible');
    expect(advisories[0]?.detail).toContain('bucket width');
  });

  it('refuses a FROM with a table alias rather than reddening a converged database', () => {
    // Parsing this fabricated the relation `public.sensor_reading r`, which no server rendering can
    // equal — and mapped to a BLOCKING advisory it made `check` permanently red with no way to
    // converge. not-compared is the honest answer.
    const aliased = DECLARED.replace('FROM sensor_reading', 'FROM sensor_reading r');
    const advisories = diffSchemaState(ir(SERVER), ir(aliased)).advisories ?? [];
    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.kind).toBe('not-compared');
  });

  // ---- step 3: the recreate step, behind DiffOptions.continuousAggregateRecreate ----

  it("emits NO step by default — 'advise' is byte-identical to 0.7.x", () => {
    const widened = DECLARED.replace("INTERVAL '1 hour'", "INTERVAL '1 day'");
    const plan = diffSchemaState(ir(SERVER), ir(widened));
    expect(plan.steps).toEqual([]);
    expect(plan.advisories?.[0]?.kind).toBe('not-expressible');
  });

  it.each([['plan'], ['apply']] as const)(
    "emits a recreate STEP in '%s' mode, and drops the advisory that replaced it",
    (mode) => {
      const widened = DECLARED.replace("INTERVAL '1 hour'", "INTERVAL '1 day'");
      const plan = diffSchemaState(ir(SERVER), ir(widened), {
        continuousAggregateRecreate: mode,
      });
      expect(plan.steps).toHaveLength(1);
      const op = plan.steps[0]?.operation;
      expect(op?.kind).toBe('recreateContinuousAggregate');
      // The DESIRED definition is what gets recreated — converging means matching the declaration.
      expect((op as { definition: string }).definition).toBe(widened);
      // The delta rides along so the preview and the refusal can name what moved.
      expect((op as { delta: string }).delta).toContain('bucket width');
      // No duplicate reporting: the advisory is replaced BY the step, not raised alongside it.
      expect(plan.advisories ?? []).toEqual([]);
    },
  );

  it('classifies the recreate step refuse-by-default, naming the data loss', () => {
    const widened = DECLARED.replace("INTERVAL '1 hour'", "INTERVAL '1 day'");
    const plan = diffSchemaState(ir(SERVER), ir(widened), {
      continuousAggregateRecreate: 'plan',
    });
    const op = plan.steps[0]?.operation;
    expect(op).toBeDefined();
    if (op === undefined) return;
    const safety = classifyOperation(op);
    expect(safety.safety).toBe('refuse-by-default');
    expect(safety.reason).toContain('DISCARDS the materialized rows');
  });

  it.each([['advise'], ['plan'], ['apply']] as const)(
    "a CONVERGED aggregate stays clean in '%s' mode — no step, no advisory",
    (mode) => {
      const plan = diffSchemaState(ir(SERVER), ir(DECLARED), {
        continuousAggregateRecreate: mode,
      });
      expect(plan.steps).toEqual([]);
      expect(plan.advisories ?? []).toEqual([]);
    },
  );

  it('an UNPARSEABLE definition still falls back to not-compared in every mode', () => {
    // The opt-in must not turn "I cannot read this" into a destructive step — that would be a guess.
    const exotic =
      'SELECT time_bucket(INTERVAL \'1 hour\', "time") AS "b", avg(value * 2) AS "v" FROM r GROUP BY 1';
    for (const mode of ['advise', 'plan', 'apply'] as const) {
      const plan = diffSchemaState(ir(SERVER), ir(exotic), {
        continuousAggregateRecreate: mode,
      });
      expect(plan.steps, `mode ${mode} must emit no step`).toEqual([]);
      expect(plan.advisories?.[0]?.kind).toBe('not-compared');
    }
  });

  it('raises NO advisory for a converged aggregate in a NON-PUBLIC schema', () => {
    // The server omits any schema on the search_path; the declared side always qualifies. Both
    // parse, so there is no not-compared fallback — this used to emit a blocking advisory on a
    // database `push` had just converged.
    const qualified = DECLARED.replace('FROM sensor_reading', 'FROM "metrics"."sensor_reading"');
    const plan = diffSchemaState(ir(SERVER), ir(qualified));
    expect(plan.advisories ?? []).toEqual([]);
  });
});
