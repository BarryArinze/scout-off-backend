module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.eslint.json',
    tsconfigRootDir: __dirname,
    ecmaVersion: 2020,
    sourceType: 'module'
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: {
    node: true,
    jest: true,
    es2021: true
  },
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-console': 'error'
  },
  overrides: [
    {
      files: ['src/utils/logger.ts'],
      rules: { 'no-console': 'off' }
    }
    ,
    {
      // Tests sometimes import helpers or types that are intentionally unused
      // during setup; treat unused vars as warnings in tests to avoid CI failures
      files: ['tests/**/*.ts'],
      rules: {
        '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
      }
    }
    ,
    {
      // scripts/*.ts are standalone CLI tools meant to print directly to the
      // terminal for a human operator (banners, progress, summaries). The
      // shared logger prepends level tags and is gated by config.logLevel,
      // which would mangle formatted output and can suppress it entirely —
      // neither is appropriate for a script whose job is to report its own
      // progress. console is intentional here, not an oversight.
      files: ['scripts/*.ts'],
      rules: { 'no-console': 'off' }
    }
  ]
};
