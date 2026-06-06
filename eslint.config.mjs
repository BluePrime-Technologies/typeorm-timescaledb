// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/.turbo/**'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // The single most important architectural guard for this package: nothing may
      // MUTATE a shared TypeORM prototype (the predecessor's fatal bug). Reading a
      // prototype (e.g. to assert it is unchanged in a test) is allowed; only writes
      // are banned. Use per-instance composition instead.
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
);
