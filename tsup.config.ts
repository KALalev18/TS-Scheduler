import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'node22',
  },
  {
    entry: { cli: 'src/cli/main.ts' },
    format: ['esm'],
    banner: { js: '#!/usr/bin/env node' },
    target: 'node22',
  },
]);
