import eslint from '@eslint/js'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'

export default defineConfig(
  { ignores: ['dist/**', 'node_modules/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-syntax': ['error',
        { selector: "CallExpression[callee.name='parse'][object.name='JSON']", message: 'Use the strict protocol JSON text parser.' },
        { selector: "CallExpression[callee.name='object'][object.name='z']", message: 'Use closedObject for protocol schemas.' },
        { selector: "CallExpression[callee.name='looseObject'][object.name='z']", message: 'Protocol schemas reject unknown fields.' },
      ],
    },
  },
)
