import tseslint from 'typescript-eslint';
export default tseslint.config({ ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/.next-*/**', '**/next-env.d.ts'] }, ...tseslint.configs.recommended, { files: ['**/*.mjs'], rules: { 'no-constant-condition': 'error' } });
