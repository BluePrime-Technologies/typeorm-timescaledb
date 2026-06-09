import { describe, expect, it } from 'vitest';
import {
  compareHypertable,
  formatDrift,
  type ActualHypertable,
  type ExpectedHypertable,
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
