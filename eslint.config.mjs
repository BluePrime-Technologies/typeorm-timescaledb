// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/.turbo/**'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Fast-feedback guard against the predecessor's fatal bug: mutating a shared
      // TypeORM prototype. It flags assignments + Object.assign/defineProperty onto
      // <Class>.prototype (reads are allowed). NOTE: this is a best-effort lint hint,
      // not the guarantee — AST-shape selectors can be bypassed (aliasing, computed
      // access, Reflect). The AUTHORITATIVE gate is the runtime no-global-mutation /
      // two-DataSource isolation test, which catches any prototype patch regardless of syntax.
      'no-restricted-syntax': [
        'error',
        {
          // X.prototype.member = ...
          selector:
            "AssignmentExpression[left.type='MemberExpression'][left.object.type='MemberExpression'][left.object.property.name='prototype'][left.object.object.name=/^(DataSource|Repository|EntityManager)$/]",
          message:
            'Do not assign to DataSource/Repository/EntityManager.prototype — use per-instance composition (the predecessor bug).',
        },
        {
          // Object.assign/defineProperty(X.prototype, ...)
          selector:
            "CallExpression[callee.object.name='Object'][callee.property.name=/^(assign|defineProperty|defineProperties)$/] MemberExpression[property.name='prototype'][object.name=/^(DataSource|Repository|EntityManager)$/]",
          message:
            'Do not mutate DataSource/Repository/EntityManager.prototype via Object.assign/defineProperty — use per-instance composition (the predecessor bug).',
        },
      ],
    },
  },
  {
    // M4.1 boundary: the migration emitter must generate DDL only through the single
    // compileOperation(s) choke point (packages/core/src/operation.ts), never by calling the
    // core SQL builders directly. This keeps one SQL-generation path that every emit target
    // (raw SQL, TS classes, direct apply) shares. Other modules (assertSchema drift, the CLI,
    // decorators) legitimately use the builders, so the restriction is scoped to this file.
    files: ['packages/typeorm/src/migrations/generate.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@blueprime/timescaledb-core',
              importNames: [
                'createHypertableSQL',
                'addColumnstorePolicySQL',
                'addRetentionPolicySQL',
                'createContinuousAggregateSQL',
                'addContinuousAggregatePolicySQL',
              ],
              message:
                'The migration emitter must build SQL only through compileOperation(s) (M4.1 choke point) — do not call the core SQL builders directly.',
            },
          ],
        },
      ],
    },
  },
);
