import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig(
    globalIgnores(['pulsify/**', 'magmastream/**', '.hydra-state/**', 'coverage/**']),
    js.configs.recommended,
    {
        files: ['Src/**/*.js', 'test/**/*.js'],
        languageOptions: {
            sourceType: 'commonjs',
            globals: {
                console: 'readonly', process: 'readonly', Buffer: 'readonly', URL: 'readonly', __dirname: 'readonly',
                setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
                clearInterval: 'readonly', structuredClone: 'readonly', fetch: 'readonly',
            },
        },
    },
);
