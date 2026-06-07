/**
 * Unified schema DSL — re-exports of TypeORM's Postgres-relevant modeling surface so
 * consumers import entities, columns, relations, repositories and query helpers from
 * `typeorm-timescaledb` and never reach for raw `typeorm`.
 *
 * These are the SAME symbols as `typeorm` (which is a peer dependency, so there is one
 * copy) — decorator and `reflect-metadata` behavior is identical and there is no
 * dual-instance hazard. Consumers still need `import 'reflect-metadata'` once and
 * `experimentalDecorators` + `emitDecoratorMetadata` in their tsconfig (standard TypeORM).
 *
 * Scope: this re-exports the surface relevant to a TimescaleDB (Postgres) project. The
 * MongoDB-only decorators (`ObjectIdColumn`, `@Entity` ObjectID flavors) are intentionally
 * excluded — they have no meaning against Postgres. Every name below is verified present in
 * both supported peer ranges (`^0.3.20 || ^1.0.0`).
 */
export {
  // entity + columns
  Entity,
  Column,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  VersionColumn,
  VirtualColumn,
  // value generation
  Generated,
  // views
  ViewEntity,
  ViewColumn,
  // single-table / class-table inheritance
  TableInheritance,
  ChildEntity,
  // adjacency / closure-table trees (Postgres)
  Tree,
  TreeChildren,
  TreeParent,
  TreeLevelColumn,
  // constraints / indexes
  Index,
  Unique,
  Check,
  // relations
  OneToOne,
  OneToMany,
  ManyToOne,
  ManyToMany,
  JoinColumn,
  JoinTable,
  RelationId,
  // runtime
  DataSource,
  Repository,
  EntityManager,
  BaseEntity,
  EntitySchema,
  QueryBuilder,
  SelectQueryBuilder,
  // find operators
  Equal,
  Not,
  In,
  MoreThan,
  MoreThanOrEqual,
  LessThan,
  LessThanOrEqual,
  Between,
  Like,
  ILike,
  IsNull,
  Any,
  ArrayContains,
  ArrayOverlap,
  And,
  Or,
  JsonContains,
  Raw,
  // query composition
  Brackets,
} from 'typeorm';

export type {
  Relation,
  EntityTarget,
  ObjectLiteral,
  DeepPartial,
  FindManyOptions,
  FindOneOptions,
  FindOptionsWhere,
  DataSourceOptions,
  MigrationInterface,
  QueryRunner,
} from 'typeorm';
