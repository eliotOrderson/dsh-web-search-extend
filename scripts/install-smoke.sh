#!/bin/bash
# Install smoke test: prove that a published spec actually BOOTS in a throwaway
# Harness home, not merely that it resolves.
#
# Every case builds a real profile with `dsh plugin add`, boots the web app on an
# OS-assigned port, and asserts both that the loader reported no entry failure and
# that the served page registers the plugin's client half.
#
# The upgrade case exists because a fresh install is not enough: an older tag's
# lock can hoist a dependency pair the new tag then inherits, and a release that
# only passed the fresh case still failed on that inherited state.
#
# Usage: scripts/install-smoke.sh <spec> [old-spec] [third-party-spec]
#   spec             candidate dependency spec, e.g.
#                    github:eliotOrderson/dsh-web-search-extend#v0.2.3
#                    or /abs/path/to/mr.robot-dsh-web-search-extend-0.2.3.tgz
#   old-spec         previously released tag to upgrade from (default v0.2.1)
#   third-party-spec extra bundle to install first, mirroring a real profile
#                    (e.g. @linxin666/dsh-web-all@^0.3.21); empty skips it
set -euo pipefail

SPEC="${1:?usage: install-smoke.sh <spec> [old-spec] [third-party-spec]}"
OLD_SPEC="${2:-github:eliotOrderson/dsh-web-search-extend#v0.2.1}"
THIRD_PARTY="${3:-}"
DSH_BIN="${DSH_BIN:-$HOME/.npm-global/bin/dsh}"
DSH="${DSH:-node --expose-internals $DSH_BIN}"

HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/dsh-install-smoke.XXXXXX")"
cleanup() { [[ "${KEEP:-0}" == "1" ]] || rm -rf "$HOME_DIR"; }
trap cleanup EXIT
export DSH_HOME="$HOME_DIR" XDG_CACHE_HOME="$HOME_DIR/.xdg/cache" \
    XDG_STATE_HOME="$HOME_DIR/.xdg/state" XDG_DATA_HOME="$HOME_DIR/.xdg/data"
STORE="$HOME_DIR/.pnpm-store"

profile() {
    local name="$1" dir="$HOME_DIR/profiles/$1"
    mkdir -p "$dir"
    cat > "$dir/package.json" <<EOF
{
  "name": "dsh-profile-$name",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"], "patchReload": "live" } }
}
EOF
    cp "$PROFILE_TEMPLATE" "$dir/pnpm-workspace.yaml"
    printf '[]\n' > "$dir/cordis.patch.yml"
    printf '[]\n' > "$dir/cordis.yml"
}

install_into() {
    local name="$1" spec="$2"
    echo "    install $spec"
    $DSH plugin --profile "$name" add "$spec" --store-dir "$STORE" >"$HOME_DIR/$name.install.log" 2>&1 ||
        { echo "    FAIL: install failed"; tail -5 "$HOME_DIR/$name.install.log"; return 1; }
}

boot() {
    local name="$1"
    local log="$HOME_DIR/$name.boot.log" pid url port jar
    $DSH --profile "$name" --port 0 --no-open >"$log" 2>&1 &
    pid=$!
    for _ in $(seq 1 60); do grep -q "dsh web: http" "$log" && break; sleep 0.5; done
    url="$(grep -o 'http://127.0.0.1:[0-9]*/?token=[A-Za-z0-9_-]*' "$log" | head -1 || true)"
    if [[ -z "$url" ]]; then
        echo "    FAIL: profile did not boot"
        sed -n '1,12p' "$log" | sed 's/^/      /'
        kill "$pid" 2>/dev/null || true
        return 1
    fi
    port="${url#http://127.0.0.1:}"; port="${port%%/*}"
    jar="$HOME_DIR/$name.cookies"
    curl -s -c "$jar" "$url" -o /dev/null
    if curl -s -b "$jar" "http://127.0.0.1:$port/" | grep -q "@mr.robot/dsh-web-search-extend"; then
        echo "    PASS: booted on $port, client half registered"
    else
        echo "    FAIL: booted but the plugin's client half is missing from the page"
        kill "$pid" 2>/dev/null || true
        return 1
    fi
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
}

case_fresh() {
    echo "  [fresh] install $SPEC into an empty profile"
    profile fresh || return 1
    install_into fresh "$SPEC" || return 1
    boot fresh
}

case_upgrade() {
    echo "  [upgrade] $OLD_SPEC installed first, then $SPEC over it"
    profile upgrade || return 1
    install_into upgrade "$OLD_SPEC" || return 1
    local poisoned
    poisoned="$(node -e 'try{console.log(require(process.argv[1]+"/node_modules/zod/package.json").version)}catch(e){console.log("none")}' "$HOME_DIR/profiles/upgrade")"
    echo "    (profile hoists zod $poisoned before the upgrade)"
    install_into upgrade "$SPEC" || return 1
    boot upgrade
}

case_third_party() {
    echo "  [third-party] $THIRD_PARTY installed first, then $SPEC"
    profile third || return 1
    install_into third "$THIRD_PARTY" || return 1
    install_into third "$SPEC" || return 1
    boot third
}

PROFILE_TEMPLATE="${PROFILE_TEMPLATE:-$HOME/.dsh/profiles/web/pnpm-workspace.yaml}"
[[ -f "$PROFILE_TEMPLATE" ]] || PROFILE_TEMPLATE="$(dirname "$0")/../.npm-smoke-workspace.yaml"
echo "smoke home: $HOME_DIR"
failures=0
case_fresh || failures=$((failures + 1))
case_upgrade || failures=$((failures + 1))
if [[ -n "$THIRD_PARTY" ]]; then case_third_party || failures=$((failures + 1)); fi
echo "result: $failures failing case(s)"
exit "$failures"
