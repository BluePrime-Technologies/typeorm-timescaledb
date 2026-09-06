import { defineConfig } from 'vitest/config';

/**
 * Legacy (TypeScript "experimental") decorator support for the test transform.
 *
 * The build reads `experimentalDecorators` / `emitDecoratorMetadata` from `tsconfig.base.json`,
 * but the TEST transform is a separate pipeline. Vitest 4 accepted the decorators without help;
 * vitest 5 runs on Vite 8, which transforms with oxc/rolldown and does not enable them by default,
 * so `@Module({})` in `src/nestjs/timescale.module.ts` failed to PARSE — a whole-file
 * `SyntaxError: Invalid or unexpected token`, not a test failure. Reproduced down to a bare
 * `@Deco({}) class Probe {}`, so it is the transform and not anything NestJS-specific.
 *
 * `emitDecoratorMetadata` mirrors the tsconfig rather than being strictly required today: NestJS
 * resolves constructor dependencies through `design:paramtypes`, which only exists when metadata
 * is emitted, so omitting it would leave DI working by accident and break on the first test that
 * injects by type.
 *
 * This file exists at all — rather than at the repo root — because vitest 5 no longer looks up a
 * config file from ancestor directories, and `pnpm test:unit` runs vitest once per package.
 */
export default defineConfig({
  oxc: {
    decorator: {
      legacy: true,
      emitDecoratorMetadata: true,
    },
  },
});
