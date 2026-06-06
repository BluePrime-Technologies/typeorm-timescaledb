import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import * as pkg from '../src/index.js';
import * as typeorm from 'typeorm';

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
      'Generated',
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
      'Raw',
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
