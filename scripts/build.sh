#!/bin/bash
# Build: bundle src/ → lib/ with esbuild
# Bare imports stay external by default: harness-provided peers must keep the
# running dsh's module instances, and profile-installed deps must stay
# single-source, so the host build lists every external package explicitly.
# The Firecrawl SDK is the one deliberate exception: it is inlined together
# with the zod pair it was built against, because its zod-to-json-schema
# dependency imports the zod/v3 subpath and breaks whenever a profile hoists a
# zod older than 3.25.28 next to a hoisted zod-to-json-schema. A new import
# therefore never lands in the bundle silently — it needs an --external entry.
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
"$ESBUILD" src/index.ts --bundle --format=esm --platform=node --target=node18 --outfile=lib/index.js --minify --tree-shaking --log-level=info \
    --external:@deepseek-ai/* --external:react --external:turndown --external:@joplin/turndown-plugin-gfm \
    --external:@mozilla/readability --external:jsdom --external:domino --external:ipaddr.js --external:undici \
    --external:@tavily/core --external:axios

echo "=== Bundling invariant → lib/invariant.js ==="
"$ESBUILD" src/invariant.ts --bundle --format=esm --platform=node --target=node18 --outfile=lib/invariant.js --minify --tree-shaking --log-level=info --packages=external

echo "=== Bundling client UI -> lib/client.js ==="
"$ESBUILD" src/ui/client.ts --bundle --format=iife --platform=browser --target=es2018 --outfile=lib/client.js --minify --log-level=warning --packages=external

echo "=== Build complete ==="
