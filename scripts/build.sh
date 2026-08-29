#!/bin/bash
# Build: bundle src/ → lib/ with esbuild
# --packages=external keeps EVERY bare import external: no dependency is ever
# inlined, so runtime module identity stays single-source (harness-provided
# peers, profile-installed deps) and a new import can never silently land in
# the bundle. Every import must therefore be declared in package.json.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -x "$ROOT/node_modules/.bin/esbuild" ]]; then
    ESBUILD="$ROOT/node_modules/.bin/esbuild"
elif [[ -n "${DSH_CHECKOUT:-}" && -x "$DSH_CHECKOUT/node_modules/.bin/esbuild" ]]; then
    ESBUILD="$DSH_CHECKOUT/node_modules/.bin/esbuild"
else
    echo "esbuild not found: run npm install (devDependency) or set DSH_CHECKOUT" >&2
    exit 1
fi

echo "=== Bundling host → lib/index.js ==="
"$ESBUILD" src/index.ts --bundle --format=esm --platform=node --target=node18 --outfile=lib/index.js --minify --tree-shaking --log-level=info --packages=external

echo "=== Bundling invariant → lib/invariant.js ==="
"$ESBUILD" src/invariant.ts --bundle --format=esm --platform=node --target=node18 --outfile=lib/invariant.js --minify --tree-shaking --log-level=info --packages=external

echo "=== Bundling client UI -> lib/client.js ==="
"$ESBUILD" src/ui/client.ts --bundle --format=iife --platform=browser --target=es2018 --outfile=lib/client.js --minify --log-level=warning --packages=external

echo "=== Build complete ==="
