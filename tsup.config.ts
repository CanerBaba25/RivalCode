import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { cli: 'apps/cli/src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  removeNodeProtocol: false,
  outDir: 'dist',
  clean: false,
  splitting: false,
  sourcemap: true,
  noExternal: [/^@rivalcode\//],
  banner: { js: '#!/usr/bin/env node' },
  external: ['node:sqlite']
})
