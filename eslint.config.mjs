import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Lint the flattened Portal bundle only (uploaded as TS, never emitted to JS). */
export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        ignores: [
            'node_modules/**',
            'test/src/**',
            'test/run-test.js',
            'test/expected-bundler-fixture-joined.js',
            'index.js',
        ],
    },
    {
        files: ['test/dist/bundle.ts'],
        rules: {
            '@typescript-eslint/ban-ts-comment': 'off',
            '@typescript-eslint/no-namespace': 'off',
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                },
            ],
        },
    }
);
