import js from '@eslint/js';
import globals from 'globals';

/**
 * Flat config (ESLint 9). Replaces the old .eslintrc.json, which ESLint 9 no
 * longer reads, so `npm run lint` could not run at all.
 *
 * Prettier owns formatting here (`npm run prettier`), so the whitespace rules
 * inherited from the old config are warnings: they flag drift without failing
 * the lint of files prettier has already formatted its own way.
 */
export default [
  {
    ignores: [
      'node_modules/**',
      'files/**',
      'exports/**',
      'coverage/**',
      '.nyc_output/**',
      'public/**',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        Parse: 'readonly',
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    rules: {
      'no-useless-escape': 'off',
      'require-atomic-updates': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Hygiene rules with a large pre-existing backlog across cloud/. Kept
      // visible as warnings so that the remaining errors are all worth acting
      // on; promote them back to 'error' once the backlog is cleared.
      'prefer-const': 'warn',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-useless-catch': 'warn',
      'no-prototype-builtins': 'warn',
      // Style, owned by prettier: report, do not fail the build.
      // 'indent' disagrees with prettier on wrapped calls and ternaries; prettier
      // is the one that actually rewrites the files, so it wins.
      indent: 'off',
      'linebreak-style': ['warn', 'unix'],
      'no-trailing-spaces': 'warn',
      'eol-last': 'warn',
      'space-in-parens': ['warn', 'never'],
      'space-infix-ops': 'warn',
      'no-multiple-empty-lines': 'warn',
      'no-var': 'warn',
      'no-await-in-loop': 'warn',
    },
  },
  {
    files: ['spec/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jasmine,
        Parse: 'readonly',
      },
    },
  },
];
