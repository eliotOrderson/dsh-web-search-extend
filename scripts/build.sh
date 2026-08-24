#!/bin/bash
# Build: bundle src/ → lib/ with esbuild
# - peerDependencies: external (provided by DSH harness)
# - dependencies: should be bundled, but marked external if not installed
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ESBUILD="/home/hydenix/Workspace/deepseek-harness-plugin/dsh-agent-bridge/node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/bin/esbuild"

# peerDependencies: provided by DSH harness, exclude from bundle
EXTERNAL="--external:@deepseek-ai/dsh-agent --external:@deepseek-ai/dsh-credentials --external:@deepseek-ai/dsh-invariants --external:@deepseek-ai/dsh-launch-environment --external:@deepseek-ai/dsh-session --external:@deepseek-ai/dsh-settings --external:@deepseek-ai/dsh-web --external:@deepseek-ai/cordis"
# dependencies: should be bundled, but mark external if not installed
EXTERNAL="$EXTERNAL --external:@deepseek-ai/schemastery --external:@tavily/core"

echo "=== Bundling host → lib/index.js ==="
"$ESBUILD" src/index.ts --bundle --format=esm --platform=node --target=node18 --outfile=lib/index.js --minify --tree-shaking --log-level=info $EXTERNAL

echo "=== Bundling invariant → lib/invariant.js ==="
"$ESBUILD" src/invariant.ts --bundle --format=esm --platform=node --target=node18 --outfile=lib/invariant.js --minify --tree-shaking --log-level=info $EXTERNAL

echo "=== Build complete ==="
