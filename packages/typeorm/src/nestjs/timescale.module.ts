import { Inject, Injectable, Logger, Module } from '@nestjs/common';
import type { DynamicModule, OnApplicationBootstrap, Provider, Type } from '@nestjs/common';
import type { DataSource, ObjectLiteral } from 'typeorm';
import { createTimescale, type TimescaleContext } from '../runtime/createTimescale.js';
import { TIMESCALE_CONTEXT, TIMESCALE_OPTIONS, getTimescaleRepositoryToken } from './tokens.js';

export interface TimescaleModuleOptions {
  /** The (already-configured) DataSource to scope the Timescale context to. */
  readonly dataSource: DataSource;
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
 * Runs the boot-time schema-drift check. Exported for testing — not part of the
 * public `./nestjs` surface.
 */
@Injectable()
export class TimescaleBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger('TimescaleModule');

  constructor(
    @Inject(TIMESCALE_CONTEXT) private readonly context: TimescaleContext,
    @Inject(TIMESCALE_OPTIONS) private readonly options: TimescaleModuleOptions,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.options.assert === false) return;
    await this.context.assertSchema({
      mode: this.options.assert ?? 'assert',
      // route warn-mode drift through Nest's logger by default, not raw console
      logger: this.options.logger ?? ((m) => this.logger.warn(m)),
    });
  }
}

/**
 * NestJS integration for TimescaleDB. Built on the per-instance `createTimescale`,
 * so it never mutates `DataSource`/`Repository` prototypes — other DataSources in the
 * app are unaffected.
 */
@Module({})
export class TimescaleModule {
  /**
   * Register the Timescale context for a DataSource and (by default) verify the live
   * schema matches the `@Hypertable` entities at application bootstrap.
   */
  static forRoot(options: TimescaleModuleOptions): DynamicModule {
    const providers: Provider[] = [
      { provide: TIMESCALE_OPTIONS, useValue: options },
      {
        provide: TIMESCALE_CONTEXT,
        useFactory: (): TimescaleContext => createTimescale(options.dataSource),
      },
      TimescaleBootstrap,
    ];
    return {
      module: TimescaleModule,
      global: options.global ?? false,
      providers,
      exports: [TIMESCALE_CONTEXT],
    };
  }

  /**
   * Register one `TimescaleRepository` provider per `@Hypertable` entity class,
   * injectable with `@InjectTimescaleRepository(Entity)`. Requires `forRoot` to be
   * present (same module, or imported as `global`).
   */
  static forFeature(entities: ReadonlyArray<Type<ObjectLiteral>>): DynamicModule {
    const providers: Provider[] = entities.map((entity) => ({
      provide: getTimescaleRepositoryToken(entity),
      useFactory: (context: TimescaleContext) => context.getRepository(entity),
      inject: [TIMESCALE_CONTEXT],
    }));
    return {
      module: TimescaleModule,
      providers,
      exports: providers.map((p) => (p as { provide: string }).provide),
    };
  }
}
