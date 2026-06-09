import { Logger, Module } from '@nestjs/common';
import type { DynamicModule, OnApplicationBootstrap, Provider, Type } from '@nestjs/common';
import type { DataSource, ObjectLiteral } from 'typeorm';
import { createTimescale, type TimescaleContext } from '../runtime/createTimescale.js';
import {
  DEFAULT_TIMESCALE_NAME,
  getTimescaleBootstrapToken,
  getTimescaleContextToken,
  getTimescaleOptionsToken,
  getTimescaleRepositoryToken,
} from './tokens.js';

export interface TimescaleModuleOptions {
  /** The (already-configured) DataSource to scope the Timescale context to. */
  readonly dataSource: DataSource;
  /** Context name — set a distinct one per DataSource for multi-DataSource apps. Default `'default'`. */
  readonly name?: string;
  /**
   * Boot-time drift check run on `onApplicationBootstrap`: `'assert'` (default)
   * throws on drift, `'warn'` logs it, `false` skips the check entirely.
   */
  readonly assert?: 'assert' | 'warn' | false;
  /** Sink for `'warn'`-mode drift. Defaults to the NestJS `Logger`. */
  readonly logger?: (message: string) => void;
  /** Register as a global module so `forFeature` works without re-importing. */
  readonly global?: boolean;
}

/**
 * Runs the boot-time schema-drift check for one context. Exported for testing — not
 * part of the public `./nestjs` surface; resolve it via `getTimescaleBootstrapToken`.
 */
export class TimescaleBootstrap implements OnApplicationBootstrap {
  private readonly nestLogger = new Logger('TimescaleModule');

  constructor(
    private readonly context: TimescaleContext,
    private readonly options: TimescaleModuleOptions,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.options.assert === false) return;
    await this.context.assertSchema({
      mode: this.options.assert ?? 'assert',
      // route warn-mode drift through Nest's logger by default, not raw console
      logger: this.options.logger ?? ((m) => this.nestLogger.warn(m)),
    });
  }
}

/**
 * NestJS integration for TimescaleDB. Built on the per-instance `createTimescale`,
 * so it never mutates `DataSource`/`Repository` prototypes — other DataSources in the
 * app are unaffected. Multiple DataSources are supported via the `name` option.
 */
@Module({})
export class TimescaleModule {
  /**
   * Register the Timescale context for a DataSource and (by default) verify the live
   * schema matches the `@Hypertable` entities at application bootstrap.
   */
  static forRoot(options: TimescaleModuleOptions): DynamicModule {
    const name = options.name ?? DEFAULT_TIMESCALE_NAME;
    const contextToken = getTimescaleContextToken(name);
    const optionsToken = getTimescaleOptionsToken(name);
    const providers: Provider[] = [
      { provide: optionsToken, useValue: options },
      {
        provide: contextToken,
        useFactory: (): TimescaleContext => createTimescale(options.dataSource),
      },
      {
        provide: getTimescaleBootstrapToken(name),
        useFactory: (context: TimescaleContext, opts: TimescaleModuleOptions) =>
          new TimescaleBootstrap(context, opts),
        inject: [contextToken, optionsToken],
      },
    ];
    return {
      module: TimescaleModule,
      global: options.global ?? false,
      providers,
      exports: [contextToken],
    };
  }

  /**
   * Register one `TimescaleRepository` provider per `@Hypertable` entity class,
   * injectable with `@InjectTimescaleRepository(Entity, name?)`. Requires the matching
   * `forRoot` (same module, or imported as `global`). `name` selects which context.
   */
  static forFeature(
    entities: ReadonlyArray<Type<ObjectLiteral>>,
    name: string = DEFAULT_TIMESCALE_NAME,
  ): DynamicModule {
    const contextToken = getTimescaleContextToken(name);
    const providers: Provider[] = entities.map((entity) => ({
      provide: getTimescaleRepositoryToken(entity, name),
      useFactory: (context: TimescaleContext) => context.getRepository(entity),
      inject: [contextToken],
    }));
    return {
      module: TimescaleModule,
      providers,
      exports: providers.map((p) => (p as { provide: string }).provide),
    };
  }
}
