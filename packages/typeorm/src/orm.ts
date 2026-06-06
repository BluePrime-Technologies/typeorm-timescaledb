/**
 * Unified schema DSL — re-exports of TypeORM's modeling surface so consumers import
 * EVERYTHING (entities, columns, relations, repositories) from `typeorm-timescaledb`
 * and never reach for raw `typeorm`.
 *
 * These are the SAME symbols as `typeorm` (which is a peer dependency, so there is one
 * copy) — decorator and `reflect-metadata` behavior is identical and there is no
 * dual-instance hazard. Consumers still need `import 'reflect-metadata'` once and
 * `experimentalDecorators` + `emitDecoratorMetadata` in their tsconfig (standard TypeORM).
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
  Generated,
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
  // common find operators
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
  Raw,
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
