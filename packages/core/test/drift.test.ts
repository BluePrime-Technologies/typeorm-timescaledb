import { describe, expect, it } from 'vitest';
import {
  compareHypertable,
  compareContinuousAggregate,
  formatDrift,
  type ActualHypertable,
  type ExpectedHypertable,
  type ActualContinuousAggregate,
  type ExpectedContinuousAggregate,
} from '../src/index.js';

const expected: ExpectedHypertable = {
  table: 'public.metrics',
  timeColumn: 'time',
  expectColumnstorePolicy: true,
  expectRetentionPolicy: true,
};

const healthy: ActualHypertable = {
  isHypertable: true,
  dimensionColumns: ['time'],
  hasColumnstorePolicy: true,
  hasRetentionPolicy: true,
};

describe('compareHypertable', () => {
  it('reports no drift when the database matches', () => {
    expect(compareHypertable(expected, healthy)).toEqual([]);
  });

  it('flags a table that is not a hypertable (and skips further checks)', () => {
    const drift = compareHypertable(expected, {
      isHypertable: false,
      dimensionColumns: [],
      hasColumnstorePolicy: false,
      hasRetentionPolicy: false,
    });
    expect(drift).toHaveLength(1);
    expect(drift[0]?.message).toContain('is not one');
    expect(drift[0]?.table).toBe('public.metrics');
  });

  it('flags a missing time partition dimension', () => {
    const drift = compareHypertable(expected, { ...healthy, dimensionColumns: ['other'] });
    expect(drift.some((d) => d.message.includes('time column "time"'))).toBe(true);
  });

  it('flags a missing space-partition dimension when one is expected', () => {
    const drift = compareHypertable(
      { ...expected, spacePartitionColumn: 'device_id' },
      { ...healthy, dimensionColumns: ['time'] },
    );
    expect(drift.some((d) => d.message.includes('space-partition column "device_id"'))).toBe(true);
  });

  it('flags missing columnstore / retention policies only when expected', () => {
    const drift = compareHypertable(expected, {
      ...healthy,
      hasColumnstorePolicy: false,
      hasRetentionPolicy: false,
    });
    expect(drift.map((d) => d.message)).toEqual([
      'columnstore policy is missing',
      'retention policy is missing',
    ]);
  });

  it('does not flag absent policies the entity does not declare', () => {
    const drift = compareHypertable(
      { ...expected, expectColumnstorePolicy: false, expectRetentionPolicy: false },
      { ...healthy, hasColumnstorePolicy: false, hasRetentionPolicy: false },
    );
    expect(drift).toEqual([]);
  });
});

describe('formatDrift', () => {
  it('renders a clean message when there is no drift', () => {
    expect(formatDrift([])).toBe('no schema drift');
  });

  it('renders each drift item on its own line', () => {
    const out = formatDrift([
      { table: 'public.metrics', message: 'retention policy is missing' },
      { table: 'public.events', message: 'is not one' },
    ]);
    expect(out).toContain('schema drift detected:');
    expect(out).toContain('  - public.metrics: retention policy is missing');
    expect(out).toContain('  - public.events: is not one');
  });
});

describe('compareContinuousAggregate', () => {
  const base: ExpectedContinuousAggregate = {
    view: 'public.reading_hourly',
    materializedOnly: false,
    expectRefreshPolicy: true,
  };
  const inSync: ActualContinuousAggregate = {
    exists: true,
    materializedOnly: false,
    hasRefreshPolicy: true,
  };

  it('returns no drift when the CAGG matches', () => {
    expect(compareContinuousAggregate(base, inSync)).toEqual([]);
  });

  it('returns no drift when both sides are materialized_only', () => {
    expect(
      compareContinuousAggregate(
        { ...base, materializedOnly: true },
        { ...inSync, materializedOnly: true },
      ),
    ).toEqual([]);
  });

  it('flags a missing continuous aggregate (and skips further checks)', () => {
    const drift = compareContinuousAggregate(base, {
      exists: false,
      materializedOnly: false,
      hasRefreshPolicy: false,
    });
    expect(drift).toHaveLength(1);
    expect(drift[0]?.message).toContain('does not exist');
  });

  it('flags a materialized_only mismatch', () => {
    const drift = compareContinuousAggregate(base, { ...inSync, materializedOnly: true });
    expect(drift).toHaveLength(1);
    expect(drift[0]?.message).toContain('materialized_only mismatch (expected false, found true)');
  });

  it('flags a missing refresh policy only when one is expected', () => {
    expect(compareContinuousAggregate(base, { ...inSync, hasRefreshPolicy: false })).toEqual([
      { table: 'public.reading_hourly', message: 'refresh policy is missing' },
    ]);
    // not expected → absent policy is not drift
    expect(
      compareContinuousAggregate(
        { ...base, expectRefreshPolicy: false },
        { ...inSync, hasRefreshPolicy: false },
      ),
    ).toEqual([]);
  });

  it('reports multiple drifts at once (mismatch + missing policy)', () => {
    const drift = compareContinuousAggregate(base, {
      exists: true,
      materializedOnly: true,
      hasRefreshPolicy: false,
    });
    expect(drift).toHaveLength(2);
    expect(formatDrift(drift)).toContain('public.reading_hourly');
  });
});
