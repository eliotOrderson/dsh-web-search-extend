import { build } from 'esbuild'
import { createRequire } from 'module'

// Use esbuild from dsh-agent-bridge (shared dependency)
const require = createRequire(import.meta.url)
const esbuildPath = '/home/hydenix/Workspace/deepseek-harness-plugin/dsh-agent-bridge/node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild'
const { build: esbuild } = await import(esbuildPath + '/lib/main.js')

const external = [
  // peerDependencies: harness-provided, never bundle
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-invariants',
  '@deepseek-ai/dsh-launch-environment',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-web',
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
]

// Host bundle: src/index.ts → lib/index.js
await esbuild({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  outfile: 'lib/index.js',
  minify: true,
  treeShaking: true,
  legalComments: 'none',
  sourcemap: false,
  logLevel: 'info',
  external,
})

// Invariant: src/invariant.ts → lib/invariant.js
await esbuild({
  entryPoints: ['src/invariant.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  outfile: 'lib/invariant.js',
  minify: true,
  treeShaking: true,
  legalComments: 'none',
  sourcemap: false,
  logLevel: 'info',
  external,
})
