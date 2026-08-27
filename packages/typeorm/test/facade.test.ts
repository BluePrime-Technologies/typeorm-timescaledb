import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import * as pkg from '../src/index.js';
import * as typeorm from 'typeorm';
import * as core from '@blueprime/timescaledb-core';

describe('unified schema DSL (facade)', () => {
  it('re-exports TypeORM modeling symbols as the SAME references (no dual instance)', () => {
    const names = [
      'Entity',
      'Column',
      'PrimaryColumn',
      'PrimaryGeneratedColumn',
      'CreateDateColumn',
      'UpdateDateColumn',
      'DeleteDateColumn',
      'VersionColumn',
      'VirtualColumn',
      'Generated',
      'ViewEntity',
      'ViewColumn',
      'TableInheritance',
      'ChildEntity',
      'Tree',
      'TreeChildren',
      'TreeParent',
      'TreeLevelColumn',
      'Index',
      'Unique',
      'Check',
      'OneToOne',
      'OneToMany',
      'ManyToOne',
      'ManyToMany',
      'JoinColumn',
      'JoinTable',
      'RelationId',
      'DataSource',
      'Repository',
      'EntityManager',
      'BaseEntity',
      'EntitySchema',
      'QueryBuilder',
      'SelectQueryBuilder',
      'Equal',
      'Not',
      'In',
      'MoreThan',
      'MoreThanOrEqual',
      'LessThan',
      'LessThanOrEqual',
      'Between',
      'Like',
      'ILike',
      'IsNull',
      'Any',
      'ArrayContains',
      'ArrayOverlap',
      'And',
      'Or',
      'JsonContains',
      'Raw',
      'Brackets',
    ] as const;
    const p = pkg as Record<string, unknown>;
    const t = typeorm as Record<string, unknown>;
    for (const n of names) {
      expect(p[n]).toBeDefined();
      expect(p[n]).toBe(t[n]); // identical reference — single TypeORM instance
    }
  });

  it('exposes our TimescaleDB extensions alongside TypeORM', () => {
    expect(typeof pkg.Hypertable).toBe('function');
    expect(typeof pkg.TimeColumn).toBe('function');
    expect(typeof pkg.HypertablePrimaryKey).toBe('function');
    expect(typeof pkg.createTimescale).toBe('function');
    expect(typeof pkg.validateHypertableMetadata).toBe('function');
  });

  it('re-exports the 0.7.0 lint + fragment-guard helpers from the installed package (#222)', () => {
    // The 0.7.0 changelog lists these three under "Added" without naming a package. They lived only
    // on `@blueprime/timescaledb-core` (a transitive dep consumers don't declare), so a consumer
    // following the changelog got `undefined`. They must resolve from `typeorm-timescaledb` itself,
    // and be the SAME references as core (no dual instance) — exactly like the TypeORM re-exports.
    expect(typeof pkg.lintPlan).toBe('function');
    expect(typeof pkg.assertSafeFragment).toBe('function');
    expect(typeof pkg.formatLintFindings).toBe('function');
    expect(pkg.lintPlan).toBe(core.lintPlan);
    expect(pkg.assertSafeFragment).toBe(core.assertSafeFragment);
    expect(pkg.formatLintFindings).toBe(core.formatLintFindings);
  });

  it('the re-exported lint + fragment-guard helpers actually work through the facade', () => {
    // A behavioural check, not just presence: the re-export is only useful if the functions run.
    // `assertSafeFragment` returns a safe fragment unchanged and rejects a statement separator;
    // `lintPlan` runs over an empty `Plan`; `formatLintFindings` renders the empty result.
    expect(pkg.assertSafeFragment('price', 'aggExpr')).toBe('price');
    expect(() => pkg.assertSafeFragment('1; DROP TABLE trades', 'aggExpr')).toThrow();
    expect(pkg.lintPlan({ steps: [] })).toEqual([]);
    expect(pkg.formatLintFindings([])).toBe('No lint findings.');
  });

  it('lets a full schema (columns + hypertable) be defined from ONE import', () => {
    const { Entity, Column, Hypertable, TimeColumn, HypertablePrimaryKey, getTimescaleMetadata } =
      pkg;
    class Trade {}
    // direct invocation (no decorator syntax) — proves the symbols all come from one import.
    // An explicit column type is given because direct invocation has no compiler-emitted
    // `design:type` (real `@Column()` syntax + emitDecoratorMetadata infers it).
    Entity('trades')(Trade);
    Column('numeric')(Trade.prototype, 'price');
    Hypertable({ chunkInterval: '1 day' })(Trade);
    TimeColumn()(Trade.prototype, 'time');
    HypertablePrimaryKey()(Trade.prototype, 'time');
    expect(getTimescaleMetadata(Trade)?.timeColumn).toBe('time');
  });
});
