import { Inject } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import type { ObjectLiteral } from 'typeorm';

/** DI token for the DataSource-scoped `TimescaleContext`. */
export const TIMESCALE_CONTEXT = Symbol('typeorm-timescaledb:context');

/** DI token for the resolved module options. */
export const TIMESCALE_OPTIONS = Symbol('typeorm-timescaledb:options');

/**
 * Stable DI token for a feature `TimescaleRepository<Entity>`, derived from the
 * entity class name.
 *
 * Note: the token is the class name, so entity classes must be uniquely named
 * across the DataSource (two same-named `@Hypertable` classes would collide).
 */
export function getTimescaleRepositoryToken(entity: Type<ObjectLiteral>): string {
  return `TimescaleRepository:${entity.name}`;
}

/**
 * Inject a feature `TimescaleRepository` registered via `TimescaleModule.forFeature([...])`.
 * Only class entities are supported (the underlying repository factory requires the class).
 *
 * @example
 * constructor(\@InjectTimescaleRepository(Trade) private readonly trades: TimescaleRepository<Trade>) {}
 */
export function InjectTimescaleRepository(
  entity: Type<ObjectLiteral>,
): ParameterDecorator & PropertyDecorator {
  return Inject(getTimescaleRepositoryToken(entity));
}
