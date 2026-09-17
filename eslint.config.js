// ESLint 8 flat config (the installed toolchain is v8.57 — no `eslint/config`
// helper exports, so plugins are wired manually).
import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

const browserGlobals = {
  ...globals.browser,
  // MV3 extension API is not in `globals.browser`
  chrome: 'readonly',
}

// ignoreRestSiblings: `const { focused, ...rest } = x` is an intentional omit
// pattern, not an unused variable.
const baseRules = {
  ...js.configs.recommended.rules,
  'no-unused-vars': ['error', { ignoreRestSiblings: true }],
}

export default [
  { ignores: ['dist', 'node_modules'] },
  {
    files: ['src/**/*.{js,jsx}', '*.jsx'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: browserGlobals,
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...baseRules,
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'warn',
      // JSX-aware usage tracking: without these, every `import React` and
      // every JSX component reference is falsely flagged as unused (ESLint 8
      // core has no JSX scope analysis).
      'react/jsx-uses-react': 'error',
      'react/jsx-uses-vars': 'error',
      'react/jsx-no-undef': 'error',
      'react/jsx-no-duplicate-props': 'error',
      'react/no-unknown-property': ['error', { ignore: ['jsx'] }],
    },
  },
  {
    // MV3 service worker — plain browser + extension globals, no JSX
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: browserGlobals,
    },
    rules: baseRules,
  },
  {
    // Node test harnesses
    files: ['scripts/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: baseRules,
  },
]
