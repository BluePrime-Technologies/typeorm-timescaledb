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

  it('re-exports the REST of the plan/lint surface from the installed package (#228)', () => {
    // #222 fixed three symbols by name; the same defect applied to the rest of the surface. These
    // must resolve from `typeorm-timescaledb` and be the SAME references as core (no dual instance).
    expect(typeof pkg.isEmptyPlan).toBe('function');
    expect(Array.isArray(pkg.ANALYZERS)).toBe(true);
    expect(pkg.isEmptyPlan).toBe(core.isEmptyPlan);
    expect(pkg.ANALYZERS).toBe(core.ANALYZERS);
    expect(pkg.compilePlan).toBe(core.compilePlan);
    expect(pkg.classifyOperation).toBe(core.classifyOperation);
  });

  it('exposes the WHOLE migration-engine workflow from one import (#228)', () => {
    // The package's premise is few imports, many capabilities. This asserts the entire
    // introspect -> diff -> classify -> compile -> lint chain is reachable from `typeorm-timescaledb`
    // alone, because a workflow that is 90% single-import still forces a second dependency on the
    // user's package.json.
    for (const name of [
      'introspect',
      'compileDesiredState',
      'diffSchemaState',
      'isEmptyPlan',
      'classifyOperation',
      'compilePlan',
      'lintPlan',
      'formatLintFindings',
      'pushSchema',
      'pullSchema',
    ]) {
      expect(
        typeof (pkg as Record<string, unknown>)[name],
        `${name} must resolve from the package`,
      ).toBe('function');
    }
  });

  it('the re-exported plan helpers actually work through the facade', () => {
    // Behavioural, not just presence. `isEmptyPlan` is the documented way to tell a PREVIEW apart
    // from an ALREADY-CONVERGED database, since `PushResult.applied === false` covers both.
    expect(pkg.isEmptyPlan({ steps: [] })).toBe(true);
    expect(pkg.isEmptyPlan({ steps: [{}] } as never)).toBe(false);

    // `ANALYZERS` is public so the rule set is inspectable rather than opaque — every entry must
    // carry the stable `code` that docs and CI suppressions key on.
    expect(pkg.ANALYZERS.length).toBeGreaterThan(0);
    for (const analyzer of pkg.ANALYZERS) {
      expect(analyzer.code).toMatch(/^TSDB\d{3}$/);
    }
  });

  it('lets a deploy gate name Plan, PlanStep and PlanAdvisory from ONE import (#228)', () => {
    // The point of re-exporting the member types: a caller can hold a `Plan` AND name what is
    // inside it. `PlanAdvisory` is load-bearing — a `not-expressible` advisory is what makes
    // `check` exit 2 — so a gate inspecting `plan.advisories` must be able to type it.
    const plan: import('typeorm-timescaledb').Plan = {
      steps: [] as readonly import('typeorm-timescaledb').PlanStep[],
      advisories: [
        { kind: 'not-expressible', object: 'public.readings_hourly', detail: 'bucket width moved' },
      ] as readonly import('typeorm-timescaledb').PlanAdvisory[],
    };
    const blocking = (plan.advisories ?? []).filter((a) => a.kind === 'not-expressible');
    expect(pkg.isEmptyPlan(plan)).toBe(true); // no steps...
    expect(blocking).toHaveLength(1); // ...yet still drift. This is why both must be checked.
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
