/**
 * `@blueprime/cross-store/prisma` — the Prisma store adapter.
 *
 * A separate entrypoint so the core (`@blueprime/cross-store`) never imports an ORM. The adapter is
 * structurally typed (see {@link PrismaClientLike}), so `@prisma/client` is an **optional** peer: a
 * Prisma client satisfies it, but nothing here imports the generated client.
 */
export { PrismaAdapter } from './adapters/prisma.js';
export type { PrismaAdapterOptions, PrismaClientLike } from './adapters/prisma.js';
export { buildFindManySql } from './sql/find-many.js';
export type { FindManySql, BuildFindManyOptions } from './sql/find-many.js';
