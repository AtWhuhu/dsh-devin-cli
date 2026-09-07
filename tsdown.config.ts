import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    clean: false,
    dts: true,
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    clean: false,
    dts: false,
    deps: {
      neverBundle: ['react', 'react-dom', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots'],
    },
  },
])

