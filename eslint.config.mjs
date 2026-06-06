// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/.turbo/**'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // The single most important architectural guard for this package:
      // nothing may mutate a shared prototype or global. Enforced here and by test.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.property.name='prototype'][object.object.name=/DataSource|Repository|EntityManager/]",
          message:
            'Do not mutate DataSource/Repository/EntityManager prototypes — use per-instance composition (the predecessor bug).',
        },
      ],
    },
  },
);
