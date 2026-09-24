#!/usr/bin/env bash
# verify-all.sh: run every script this repo documents, from a clean checkout of HEAD.
#
#   ./verify-all.sh          run everything that can run on this machine
#   ./verify-all.sh --list   print the plan (what runs, what skips, and why), then exit
#
# It clones this repo's committed HEAD into a temporary directory first, so nothing
# that exists only in your working tree, uncommitted or gitignored, can make a script
# pass here: a file that was never committed, a path that exists on one machine, an
# import that only resolves from one directory. A clean checkout fails on all three,
# the way it would for you.
#
# Setup follows the README exactly, including the browser installs. Scripts then run
# one at a time, so no run contends with another for CPU or memory.
#
# Optional pieces are skipped cleanly when absent, and a skip never fails the run:
#
#   GL_TOKEN          GoLogin cloud probes. They create profiles through the API and
#                     delete them when they finish, including on failure.
#   LIGHTPANDA_PATH   Lightpanda binary. Also looked for at ./.browsers/lightpanda/lightpanda
#                     in this checkout and at ~/.local/bin/lightpanda.
#   SKIP_HEADFUL=1    Skip the three scripts that open a visible Chrome window. Set for
#                     you on Linux when there is no display.
#   MAX_SESSIONS      Passed to the GoLogin session probes (they default to 6).
#   VERIFY_ITER       Iterations for the leak scripts (default 20). At 20 they prove
#                     the code path runs; the published numbers come from 200.
#   VERBOSE=1         Show the last lines of every passing script, not only failures.
#   KEEP_WORKDIR=1    Keep the temporary checkout for inspection.
#
# A full run took 6 minutes without GoLogin and 13 with it, on an Apple M3; most of that
# is the Chrome download, the concurrency sweep and the cloud session probes. The exit
# status is 0 only if nothing failed.
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHROME_BUILD="153.0.8010.47"
ITER="${VERIFY_ITER:-20}"
LIST=0; [ "${1:-}" = "--list" ] && LIST=1

# A failing script does not always exit non-zero: a script can catch its own error,
# print it and still exit 0. So output is checked as well. No script prints any of
# these when it works. "not found" is deliberately absent, because tls-probe prints
# "Lightpanda not found; skipping its row" as a legitimate skip.
FAIL_PATTERN='ERR_|Error:|TypeError|ReferenceError|SyntaxError|ENOENT|Cannot find|UnhandledPromiseRejection'

# ---------------------------------------------------------------- what can run here
GOLOGIN=0; GOLOGIN_WHY="GL_TOKEN not set"
[ -n "${GL_TOKEN:-}" ] && { GOLOGIN=1; GOLOGIN_WHY=""; }

HEADFUL=1; HEADFUL_WHY=""
if [ "${SKIP_HEADFUL:-0}" = 1 ]; then
  HEADFUL=0; HEADFUL_WHY="SKIP_HEADFUL=1"
elif [ "$(uname -s)" = Linux ] && [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  HEADFUL=0; HEADFUL_WHY="no display"
fi

LP=""
for candidate in "${LIGHTPANDA_PATH:-}" "$REPO_ROOT/.browsers/lightpanda/lightpanda" "$HOME/.local/bin/lightpanda"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then LP="$candidate"; break; fi
done
LP_WHY="Lightpanda not found (set LIGHTPANDA_PATH)"

# ---------------------------------------------------------------- reporting
PASS=0; FAIL=0; SKIP=0; FAILED=()
run() {  # run <label> <command...>
  local label="$1"; shift
  if [ "$LIST" = 1 ]; then printf '  RUN   %s\n' "$label"; return; fi
  local out rc start
  start=$(date +%s)
  out=$("$@" 2>&1); rc=$?
  if [ "$rc" -eq 0 ] && ! grep -qE "$FAIL_PATTERN" <<<"$out"; then
    PASS=$((PASS + 1)); printf '  PASS  %-38s %4ss\n' "$label" "$(( $(date +%s) - start ))"
    if [ "${VERBOSE:-0}" = 1 ]; then tail -3 <<<"$out" | cut -c1-150 | sed 's/^/        | /'; fi
  else
    FAIL=$((FAIL + 1)); FAILED+=("$label"); printf '  FAIL  %-38s rc=%s\n' "$label" "$rc"
    tail -8 <<<"$out" | cut -c1-150 | sed 's/^/        | /'
  fi
}
skip() {  # skip <label> <reason>
  SKIP=$((SKIP + 1)); printf '  SKIP  %-38s %s\n' "$1" "$2"
}
section() { printf '\n%s\n' "$1"; }

# ---------------------------------------------------------------- setup
WORK=""; CREEPJS_PROFILE=""
cleanup() {
  if [ -n "$CREEPJS_PROFILE" ] && [ -n "${GL_TOKEN:-}" ]; then
    curl -s -X DELETE "https://api.gologin.com/browser/$CREEPJS_PROFILE" \
      -H "Authorization: Bearer $GL_TOKEN" >/dev/null 2>&1 || true
  fi
  if [ -n "$WORK" ] && [ "${KEEP_WORKDIR:-0}" != 1 ]; then rm -rf "$WORK"; fi
}
trap cleanup EXIT

printf 'verify-all: %s at %s\n' "$REPO_ROOT" "$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')"
if [ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]; then
  echo "note: your working tree has uncommitted changes. They are NOT tested; only committed HEAD is."
fi

section "setup"
if [ "$LIST" = 1 ]; then
  echo "  clone committed HEAD into a temporary directory"
  echo "  npm install"
  echo "  npx @puppeteer/browsers install chrome@$CHROME_BUILD --path ./.browsers"
  echo "  npx @puppeteer/browsers install chromedriver@$CHROME_BUILD --path ./.browsers"
else
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/verify-all.XXXXXX")"
  git clone -q "$REPO_ROOT" "$WORK/repo" || { echo "  FAIL  clone"; exit 1; }
  cd "$WORK/repo" || exit 1
  printf '  checkout %s\n' "$WORK/repo"
  run "npm install"                  npm install --silent
  run "install chrome@$CHROME_BUILD"  npx -y @puppeteer/browsers install "chrome@$CHROME_BUILD" --path ./.browsers
  run "install chromedriver"          npx -y @puppeteer/browsers install "chromedriver@$CHROME_BUILD" --path ./.browsers
  if [ "$FAIL" -gt 0 ]; then echo; echo "setup failed; nothing else can run."; exit 1; fi
fi
[ -n "$LP" ] && export LIGHTPANDA_PATH="$LP"

# ---------------------------------------------------------------- local, headless
section "local, headless"
run "latency-table.txt matches its source"  bash -c 'node make-latency-table.mjs >/dev/null && git diff --quiet -- latency-table.txt'
run "bench.mjs"                              env REPEATS="${VERIFY_REPEATS:-1}" node bench.mjs
run "cdc-properties.mjs"                     node cdc-properties.mjs
run "edge/probe.mjs"                         node edge/probe.mjs
run "edge/closed-shadow.mjs"                 node edge/closed-shadow.mjs
run "runtime-enable-tell.mjs"                node runtime-enable-tell.mjs
run "isolation-probe.mjs"                    node isolation-probe.mjs
run "canvas-verify.mjs"                      node canvas-verify.mjs
run "bidi-load-cost.mjs"                     node bidi-load-cost.mjs
run "local-patch-limit.mjs"                  node local-patch-limit.mjs
run "concurrency-sweep.mjs"                  node concurrency-sweep.mjs
run "heavy/profile-pages.mjs"                node heavy/profile-pages.mjs
run "heavy/run.mjs"                          node heavy/run.mjs
run "heavy/selector-cost.mjs"                node heavy/selector-cost.mjs
run "heavy/heavy-memory.mjs"                 node heavy/heavy-memory.mjs
run "leak/gc-check.mjs"                      env ITER="$ITER" node --expose-gc leak/gc-check.mjs
for arm in idle-only gc-only gc-plus-idle browser-gc; do
  run "leak/gc-isolate.mjs --arm=$arm"       node --expose-gc leak/gc-isolate.mjs --arm="$arm"
done
for mode in reuse-page new-page-closed new-context-closed new-context-leaked; do
  run "leak/run.mjs --mode=$mode"            env ITER="$ITER" SAMPLE=10 node leak/run.mjs --mode="$mode"
done
run "mcp-token-cost.mjs"                     bash -c 'npm i --no-save --silent @playwright/mcp@0.0.82 gpt-tokenizer@4.0.0 && node mcp-token-cost.mjs'
if [ -n "$LP" ]; then run "lp-vs-chrome.mjs" node lp-vs-chrome.mjs; else skip "lp-vs-chrome.mjs" "$LP_WHY"; fi

# ---------------------------------------------------------------- local, headful
section "local, headful (these open a visible Chrome window)"
if [ "$HEADFUL" = 1 ]; then
  if [ "$GOLOGIN" = 1 ]; then
    if [ "$LIST" = 1 ]; then
      run "creepjs-checks.mjs, local and cloud" true
    else
      CREEPJS_PROFILE=$(curl -s -X POST https://api.gologin.com/browser/quick \
        -H "Authorization: Bearer $GL_TOKEN" -H "Content-Type: application/json" \
        -d '{"os":"win","osSpec":"win11","name":"verify-creepjs"}' \
        | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).id||"")}catch{console.log("")}})')
      if [ -n "$CREEPJS_PROFILE" ]; then
        run "creepjs-checks.mjs, local and cloud" env GL_PROFILE="$CREEPJS_PROFILE" node creepjs-checks.mjs
      else
        FAIL=$((FAIL + 1)); FAILED+=("creepjs-checks.mjs"); echo "  FAIL  creepjs-checks.mjs: could not create a GoLogin profile"
      fi
    fi
  else
    run "creepjs-checks.mjs, local only" env -u GL_TOKEN -u GL_PROFILE node creepjs-checks.mjs
  fi
  run "ja3-stability.mjs"                    node ja3-stability.mjs
  run "tls-probe.mjs"                        node tls-probe.mjs
else
  for s in creepjs-checks.mjs ja3-stability.mjs tls-probe.mjs; do skip "$s" "$HEADFUL_WHY"; done
fi

# ---------------------------------------------------------------- GoLogin cloud
section "GoLogin cloud"
GL_SCRIPTS=(gl-exit-ip gl-fingerprint gl-fingerprint-refresh gl-useragent-currency gl-remote-latency gl-session-cost gl-session-release)
if [ "$GOLOGIN" = 1 ]; then
  run "gl-exit-ip.mjs"                       node gl-exit-ip.mjs
  run "gl-fingerprint.mjs"                   env -u GL_PROFILES node gl-fingerprint.mjs
  run "gl-fingerprint-refresh.mjs"           node gl-fingerprint-refresh.mjs
  run "gl-useragent-currency.mjs"            node gl-useragent-currency.mjs
  run "gl-remote-latency.mjs"                env REPEATS=1 node gl-remote-latency.mjs
  run "gl-session-cost.mjs"                  node --expose-gc gl-session-cost.mjs
  run "gl-session-release.mjs"               env -u GL_PROFILES node gl-session-release.mjs
else
  for s in "${GL_SCRIPTS[@]}"; do skip "$s.mjs" "$GOLOGIN_WHY"; done
fi

# ---------------------------------------------------------------- result
if [ "$LIST" = 1 ]; then printf '\n%s\n' "--list: nothing was run."; exit 0; fi
printf '\npass %d   fail %d   skip %d\n' "$PASS" "$FAIL" "$SKIP"
if [ "$FAIL" -gt 0 ]; then
  printf 'failed:\n'; printf '  %s\n' "${FAILED[@]}"
  exit 1
fi
