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
);
