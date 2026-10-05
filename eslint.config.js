import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/',
      'openhanako-*/**',
      'vendor/**',
      'artifacts/**',
      '**/dist/**',
      'dist-server/**',
      'dist-server-bundle/**',
      'dist-computer-use/**',
      'dist-sandbox/**',
      'desktop/dist-renderer/**',
      'desktop/native/**/.build/**',
      '.cache/**',
      '**/*.cjs',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['desktop/src/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },

  {
    files: ['desktop/src/shared/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  {
    files: [
      'cli/**/*.{js,ts}',
      'core/**/*.{js,ts}',
      'hub/**/*.{js,ts}',
      'index.js',
      'lib/**/*.{js,ts}',
      'plugins/**/*.{js,ts}',
      'scripts/**/*.{js,mjs,ts}',
      'server/**/*.{js,ts}',
      'shared/**/*.{js,ts}',
      'tests/**/*.{js,ts,tsx}',
      'vite.config.*.js',
    ],
    languageOptions: {
      globals: {
        ...globals.node,
        fetch: 'readonly',
        AbortSignal: 'readonly',
      },
    },
  },

  {
    files: ['tests/**/*.{js,ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },

  {
    files: [
      'scripts/packaged-runtime-smoke.mjs',
      'scripts/pwa-theme-behavior-audit.mjs',
      'scripts/theme-screenshot-audit.mjs',
      'scripts/ui-overlap-regression.mjs',
    ],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
        fetch: 'readonly',
      },
    },
  },

  {
    files: [
      'packages/plugin-sdk/src/**/*.ts',
      'desktop/src/**/*.{ts,tsx}',
      'packages/plugin-components/src/**/*.{ts,tsx}',
    ],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },

  {
    files: ['desktop/src/react/**/*.tsx'],
    ignores: [
      'desktop/src/react/**/__tests__/**',
      'desktop/src/react/**/*.test.tsx',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='document'][callee.property.name='createElement']",
          message:
            'React components should render DOM through JSX. Use an eslint-disable comment only for intentional low-level DOM utilities.',
        },
      ],
    },
  },

  {
    rules: {
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'prefer-const': 'warn',
      'no-useless-escape': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },

  {
    files: ['core/**/*.{js,ts}', 'lib/**/*.{js,ts}', 'hub/**/*.{js,ts}', 'server/**/*.{js,ts}'],
    ignores: ['lib/pi-sdk/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['@earendil-works/*'],
          message: 'Import PI SDK packages through lib/pi-sdk/index.js.',
        }],
      }],
    },
  },

  {
    files: ['server/routes/**/*.{js,ts}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='engine'][property.name=/^_/]",
          message: 'Use public Engine APIs from server routes instead of private engine members.',
        },
      ],
    },
  },

  {
    files: [
      'tests/**/*.{js,ts,tsx}',
      'desktop/src/**/__tests__/**/*.{ts,tsx}',
      'desktop/src/**/*.test.{ts,tsx}',
    ],
    rules: {
      // Test fixtures and mocks often need partial structural objects. Keep
      // production code strict while avoiding noisy mock-only type debt.
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
