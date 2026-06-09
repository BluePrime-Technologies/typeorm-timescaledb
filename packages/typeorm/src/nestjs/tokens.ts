import { Inject } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import type { ObjectLiteral } from 'typeorm';

/** Name of the default Timescale context when `forRoot` is called without a `name`. */
export const DEFAULT_TIMESCALE_NAME = 'default';

/** DI token for a named DataSource-scoped `TimescaleContext`. */
export function getTimescaleContextToken(name: string = DEFAULT_TIMESCALE_NAME): string {
  return `TimescaleContext:${name}`;
}

/** DI token for a named context's resolved options. */
export function getTimescaleOptionsToken(name: string = DEFAULT_TIMESCALE_NAME): string {
  return `TimescaleOptions:${name}`;
}

/** DI token for a named context's bootstrap (drift-check) provider. */
export function getTimescaleBootstrapToken(name: string = DEFAULT_TIMESCALE_NAME): string {
  return `TimescaleBootstrap:${name}`;
}

/**
 * Stable DI token for a feature `TimescaleRepository<Entity>`. The `name` scopes the
 * token to a specific Timescale context (DataSource), so the same entity class can be
 * registered against multiple DataSources without colliding.
 *
 * Note: within a single context, entity classes must be uniquely named (the token uses
 * the class name) — the same constraint as `@nestjs/typeorm`'s `getRepositoryToken`.
 */
export function getTimescaleRepositoryToken(
  entity: Type<ObjectLiteral>,
  name: string = DEFAULT_TIMESCALE_NAME,
): string {
  return `TimescaleRepository:${name}:${entity.name}`;
}

/** Inject a named Timescale context (the one registered via `forRoot({ name })`). */
export function InjectTimescaleContext(name?: string): ParameterDecorator & PropertyDecorator {
  return Inject(getTimescaleContextToken(name));
}

/**
 * Inject a feature `TimescaleRepository` registered via `TimescaleModule.forFeature([...], name?)`.
 * Only class entities are supported (the underlying repository factory requires the class).
 *
 * @example
 * constructor(\@InjectTimescaleRepository(Trade) private readonly trades: TimescaleRepository<Trade>) {}
 */
export function InjectTimescaleRepository(
  entity: Type<ObjectLiteral>,
  name?: string,
): ParameterDecorator & PropertyDecorator {
  return Inject(getTimescaleRepositoryToken(entity, name));
}
