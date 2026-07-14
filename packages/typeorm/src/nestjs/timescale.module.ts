import { Logger, Module } from '@nestjs/common';
import type {
  DynamicModule,
  FactoryProvider,
  ModuleMetadata,
  OnApplicationBootstrap,
  Provider,
  Type,
} from '@nestjs/common';
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
 * Options for {@link TimescaleModule.forRootAsync}, mirroring the standard NestJS
 * async-module pattern (`imports` + `inject` + `useFactory`). `Args` is inferred
 * from the `useFactory` signature so injected providers keep their real types.
 */
export interface TimescaleModuleAsyncOptions<Args extends unknown[] = unknown[]> extends Pick<
  ModuleMetadata,
  'imports'
> {
  /** Context name — same as `forRoot`'s `name`. Default `'default'`. */
  readonly name?: string;
  /** Register as a global module so `forFeature` works without re-importing. */
  readonly global?: boolean;
  /**
   * Resolve the options, typically from an async source (`ConfigService`, a
   * remote config fetch, etc.). Return `undefined` to register a **no-op**
   * context — no `DataSource`, no bootstrap drift check — for environments
   * where TimescaleDB isn't configured (local dev, tests). Any consumer that
   * injects the context or repositories in that case must mark the
   * dependency `@Optional()`, since nothing is provided under the token.
   */
  readonly useFactory: (
    ...args: Args
  ) => Promise<TimescaleModuleOptions | undefined> | TimescaleModuleOptions | undefined;
  /** Providers injected into `useFactory`, in order — matches `Args` positionally. */
  readonly inject?: FactoryProvider['inject'];
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
   * Register the Timescale context asynchronously — the `DataSource` (and rest of
   * {@link TimescaleModuleOptions}) is resolved via `useFactory`/`inject`/`imports`,
   * mirroring the standard NestJS async-module pattern. Useful when connection config
   * comes from `ConfigService` or another async source at runtime.
   *
   * If `useFactory` resolves `undefined`, this registers a no-op context (no
   * `DataSource`, no bootstrap drift check) instead of failing module construction —
   * for environments where TimescaleDB isn't configured. Consumers must inject the
   * context/`forFeature` repositories as `@Optional()` when a no-op is possible.
   */
  static forRootAsync<Args extends unknown[] = unknown[]>(
    options: TimescaleModuleAsyncOptions<Args>,
  ): DynamicModule {
    const name = options.name ?? DEFAULT_TIMESCALE_NAME;
    const contextToken = getTimescaleContextToken(name);
    const optionsToken = getTimescaleOptionsToken(name);
    const providers: Provider[] = [
      {
        provide: optionsToken,
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      },
      {
        provide: contextToken,
        useFactory: (resolved?: TimescaleModuleOptions): TimescaleContext | undefined =>
          resolved ? createTimescale(resolved.dataSource) : undefined,
        inject: [optionsToken],
      },
      {
        provide: getTimescaleBootstrapToken(name),
        useFactory: (
          context: TimescaleContext | undefined,
          resolved: TimescaleModuleOptions | undefined,
        ): TimescaleBootstrap | undefined =>
          context && resolved ? new TimescaleBootstrap(context, resolved) : undefined,
        inject: [contextToken, optionsToken],
      },
    ];
    return {
      module: TimescaleModule,
      global: options.global ?? false,
      imports: options.imports ?? [],
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
