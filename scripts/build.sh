#!/bin/bash
# Build: bundle src/ → lib/ with esbuild
# - peerDependencies: external (provided by DSH harness)
# - dependencies: should be bundled, but marked external if not installed
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ESBUILD="/home/hydenix/Workspace/deepseek-harness-plugin/dsh-agent-bridge/node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/bin/esbuild"

# peerDependencies: provided by DSH harness, exclude from bundle
EXTERNAL="--external:@deepseek-ai/dsh-agent --external:@deepseek-ai/dsh-credentials --external:@deepseek-ai/dsh-invariants --external:@deepseek-ai/dsh-launch-environment --external:@deepseek-ai/dsh-session --external:@deepseek-ai/dsh-settings --external:@deepseek-ai/dsh-tools --external:@deepseek-ai/dsh-web --external:@deepseek-ai/dsh-web-search-deepseek --external:@deepseek-ai/cordis --external:@deepseek-ai/schemastery"
# CJS/runtime-dependent packages: cannot bundle into ESM cleanly (esbuild CJS
# interop or dynamic require of node builtins), so they stay external.
EXTERNAL="$EXTERNAL --external:@tavily/core --external:firecrawl --external:turndown --external:@joplin/turndown-plugin-gfm --external:domino --external:jsdom --external:@mozilla/readability --external:undici --external:ipaddr.js"

echo "=== Bundling host → lib/index.js ==="
"$ESBUILD" src/index.ts --bundle --format=esm --platform=node --target=node18 --outfile=lib/index.js --minify --tree-shaking --log-level=info $EXTERNAL

echo "=== Bundling invariant → lib/invariant.js ==="
"$ESBUILD" src/invariant.ts --bundle --format=esm --platform=node --target=node18 --outfile=lib/invariant.js --minify --tree-shaking --log-level=info $EXTERNAL

echo "=== Bundling client UI -> lib/client.js ==="
"$ESBUILD" src/ui/client.ts --bundle --format=iife --platform=browser --target=es2018 --outfile=lib/client.js --minify --log-level=warning --external:react --external:@deepseek-ai/dsh-client-ui-primitives --external:@deepseek-ai/dsh-client-runtime --external:@deepseek-ai/dsh-client-ui-slots --external:@deepseek-ai/dsh-client-locale --external:@deepseek-ai/cordis

echo "=== Build complete ==="
