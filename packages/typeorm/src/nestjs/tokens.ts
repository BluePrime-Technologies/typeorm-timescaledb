import { Inject } from '@nestjs/common';
import type { EntityTarget, ObjectLiteral } from 'typeorm';

/** DI token for the DataSource-scoped `TimescaleContext`. */
export const TIMESCALE_CONTEXT = Symbol('typeorm-timescaledb:context');

/** DI token for the resolved module options. */
export const TIMESCALE_OPTIONS = Symbol('typeorm-timescaledb:options');

/** The entity's display name, used to build a stable per-entity provider token. */
function entityName(entity: EntityTarget<ObjectLiteral>): string {
  if (typeof entity === 'function') return entity.name;
  if (typeof entity === 'string') return entity;
  // EntitySchema or { name } objects
  const named = entity as { name?: unknown; options?: { name?: unknown } };
  const name = named.options?.name ?? named.name;
  return typeof name === 'string' ? name : String(entity);
}

/** Stable DI token for a feature `TimescaleRepository<Entity>`. */
export function getTimescaleRepositoryToken(entity: EntityTarget<ObjectLiteral>): string {
  return `TimescaleRepository:${entityName(entity)}`;
}

/**
 * Inject a feature `TimescaleRepository` registered via `TimescaleModule.forFeature([...])`.
 *
 * @example
 * constructor(\@InjectTimescaleRepository(Trade) private readonly trades: TimescaleRepository<Trade>) {}
 */
export function InjectTimescaleRepository(
  entity: EntityTarget<ObjectLiteral>,
): ParameterDecorator & PropertyDecorator {
  return Inject(getTimescaleRepositoryToken(entity));
}
