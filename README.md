# browser-automation-bench

Reproduces every figure in *Best Browser Automation Tools in 2026: Benchmark Guide*.

Drives one pinned Chrome build from Playwright, Puppeteer, Selenium Classic, and a raw WebDriver
BiDi client, plus Lightpanda as a non-Chromium engine, and reports what each costs: client memory,
browser memory, process count, CPU time, and protocol round trips for an identical extraction task.

## Verify the whole repo

```bash
./verify-all.sh --list   # what would run, what would be skipped, and why
./verify-all.sh          # run it: about 6 minutes, or 13 with GL_TOKEN set
```

It clones the committed HEAD into a temporary directory, installs everything as this README
says, runs every documented script one at a time, and reports pass, fail or skip for each. It
does its own setup, so you do not need the steps below to use it. Nothing in your working tree
can make it pass: a file that was never committed, a path that exists on one machine or an
import that only resolves from one directory fails here the way it would for you.

The GoLogin scripts run only when `GL_TOKEN` is set, Lightpanda only when it can be found, and
the three scripts that open a visible Chrome window can be skipped with `SKIP_HEADFUL=1`. A skip
never fails the run. The script's header lists every option.

## Setup

`package.json` pins the client versions the guide reports and the browser is pinned here, so
that a clean checkout reproduces the published numbers rather than whatever was released this week:

```bash
npm install
npx @puppeteer/browsers install chrome@153.0.8010.47 --path ./.browsers
npx @puppeteer/browsers install chromedriver@153.0.8010.47 --path ./.browsers
```

Every script imports from `lib/`, which holds the Chrome launcher, the `phys_footprint` and CPU
readers, the fixture server, and the counting WebSocket proxy. The scripts do not run without it.

Lightpanda is optional. Install it and the fifth row appears; skip it and the row is omitted:

```bash
curl -fsSL https://pkg.lightpanda.io/install.sh | bash   # installs a nightly build; there is no pinned release to match
export LIGHTPANDA_PATH=~/.local/bin/lightpanda
```

## Run

```bash
node bench.mjs                      # local, 3 repeats
RTT=60 node bench.mjs               # inject 60 ms round-trip latency
REPEATS=5 RTT=20 node bench.mjs     # more repeats, 20 ms latency
```

Each run also writes `bench-results.json`, which is not tracked. The runs the guide quotes are
kept in `results/`, one file per script, named `out-<name>.txt`. `results/out-fig1.txt` is the
run that produced the guide's main table, transcribed from the terminal capture published as
figure 1 and checked against it value by value. `latency-table.txt` stays at the top level
because figure 2 shows it being printed there.

## What it measures differently

**Browser memory is `phys_footprint` on macOS and PSS on Linux, never a sum of `ps` RSS.**
Summing RSS across a Chromium process tree counts the shared binary image once per process. On
the reference machine that overstated the browser figure by 2.3x to 3.0x across runs.

**Protocol messages are counted on the wire.** A proxy runs between the automation client and
the browser and counts every frame, so the number is what actually passed through the socket
rather than what the API surface suggests. The same proxy injects the `RTT` delay in both
directions, so every arm gets the same full round-trip delay.

**CPU time comes from Chrome's own accounting.** `SystemInfo.getProcessInfo` is available on the
browser-level CDP session, not a page session. Lightpanda does not implement it, so its CPU time
comes from `ps`.

**Each client runs in its own process.** Importing all four into one process makes every
client-memory measurement cumulative and silently reports the wrong number for every client after
the first.

**The RTT injection is software, and was checked against real traffic shaping.** Toxiproxy with
30 ms each way, 10 ms jitter, and a 1 MB/s limit agreed with this harness within 2% at 60 ms.
Jitter did not change the ranking, and the bandwidth cap cost Playwright about 7% and Puppeteer
nothing, which is what the 493 KB against 98 KB upload difference predicts.

## A note on the Lightpanda row

Every other build in this harness is pinned to a patch version. Lightpanda is not, and cannot be:
its installer defaults to `VERSION="${LIGHTPANDA_VERSION:-nightly}"`, and the binary self-reports
a string like `1.0.0-nightly.9588+4d1d5f129` while the project's real releases are at 0.4.x. Two
people running this on the same day can get different builds, and did: a verification run on
another machine reported `1.0.0-nightly.9684+11e1505cd` against this one's `...9588+4d1d5f129`.

The measured numbers matched across both. The guide labels the row `Lightpanda nightly` rather than
a version number for that reason.

## mcp-token-cost.mjs

Measures what a coding agent's page read costs in tokens. It drives Playwright MCP over
stdio JSON-RPC with no model involved, so the numbers come from the tool rather than from
any model, and it tokenizes the payloads rather than estimating from character counts.

```bash
npm i @playwright/mcp@0.0.82 gpt-tokenizer@4.0.0
node mcp-token-cost.mjs
```

`browser_snapshot` and a targeted `browser_evaluate` each cost three CDP messages, so the
wire cost is identical. The snapshot tokenized to 10x to 12x the evaluation for the same
records, because it describes every element whether the caller needed it or not.

`results/out-mcp-token-cost.txt` holds two runs at the pinned versions above. books.toscrape.com,
a static sandbox, gave 7,719 snapshot tokens against 641 for the evaluation on both. Hacker News
gave 13,587 against 1,349; its front page is live, so that pair changes with the day's stories
and yours will differ. The ratio stayed in the same range, 12.0 and 10.1. The versions are pinned
because the snapshot format is the thing being measured, and a different `@playwright/mcp` can
serialize the same page differently.

Two things this gets right that are easy to get wrong. The extractor is **per host**, so the
comparison runs against a real extraction rather than an empty array from a selector that
does not match. And the token counts come from a real tokenizer: a chars/4 estimate
overstated the ratio by up to a third on these pages.

## concurrency-sweep.mjs

Sweeps 1, 2, 4, 8, and 16 concurrent units across the two setups people actually
choose between: N browser contexts inside one browser, and N separate browsers. Reports
browser memory, process count, CPU time, and wall time at each level.

```bash
node concurrency-sweep.mjs
```

Both curves are linear. A context costs about 213 MB after a 431 MB first; a separate
browser costs about 410 MB each. The formula `431 + 213 * (n - 1)` predicts the measured
16-context figure within 1%. Separate browsers finish faster because they do not compete
inside one browser process, and cost about 1.8x the memory and 2.6x the CPU time to do it.

`results/out-concurrency.txt` holds the run these figures come from. Wall time is the figure
to trust least, because it depends on what else the machine is doing.

## isolation-probe.mjs and canvas-verify.mjs

What that extra memory does and does not give you. `isolation-probe.mjs` compares nine
fingerprint values across two contexts in one browser against two separate browsers, and
checks whether one context can read another's `localStorage`. `canvas-verify.mjs` hashes a
canvas render across three browsers with three separate user data directories.

```bash
node isolation-probe.mjs
node canvas-verify.mjs
```

Contexts isolate storage. Neither contexts nor separate Chrome browsers isolate the machine:
all four instances produced one canvas hash, with identical `hardwareConcurrency`,
`deviceMemory`, and `platform`. Process separation gives you crash isolation, not a new identity.

## edge/ — where one evaluation stops working

The guide tells readers to batch a locator walk into a single in-page evaluation. This
measures its limit. `edge/fixture.mjs` serves 35 records rendered in the seven ways real pages
use: server-rendered, deferred by 800 ms, shown after a click, inside an open shadow root,
inside a closed one, and inside same-origin and cross-origin iframes.

```bash
node edge/probe.mjs          # how far one evaluation gets
node edge/closed-shadow.mjs  # page script vs Playwright locator vs CDP
```

One evaluation at `domcontentloaded` finds 5 of 35. Waiting finds 10, clicking 15, walking open
shadow roots 20. Each iframe needs its own evaluation, and the two iframes hold 5 each, so page
script doing everything it can finds 30 of 35: `reachableWalkingOpenShadowInEveryFrame`.

`edge/probe.mjs` prints two totals. `reachableAcrossAllFrames` is 25, because a plain
`querySelectorAll` misses the 5 records inside the main frame's open shadow host.
`reachableWalkingOpenShadowInEveryFrame` is 30, the figure the guide states.

The closed shadow root's 5 are invisible
to page script (`shadowRoot` is `null`) and to a Playwright locator, but `DOM.getDocument` with
`pierce: true` returns all five over CDP, so the protocol is strictly more capable than the
page script the optimization runs in.

## leak/ — what a long run actually does

"It leaks, restart the browser every N pages" is common advice in comparison articles.
`leak/fixture.mjs` serves a page with the things that really leak: event listeners holding
DOM references in closures, a running timer, and 200 detached nodes. `leak/run.mjs` loops the
same extraction 200 times in four patterns and samples browser memory, process count, client
RSS, and JS heap during the run.

```bash
ITER=200 SAMPLE=25 node leak/run.mjs --mode=reuse-page
ITER=200 SAMPLE=25 node leak/run.mjs --mode=new-page-closed
ITER=200 SAMPLE=25 node leak/run.mjs --mode=new-context-closed
ITER=200 SAMPLE=10 node leak/run.mjs --mode=new-context-leaked   # aborts past 6 GB
```

Measured over 200 iterations each:

| Pattern | Browser | Processes |
|---|---|---|
| new context, closed | 510 to 563 MB, flat | 8 throughout |
| reuse one page | 514 to 689 MB, plateaus by iteration 75 | 9 throughout |
| new page, closed | 577 to 953 MB, slow increase | 10 rising to 20, then flat |
| new context, never closed | 708 MB to 6.5 GB by iteration 30 | 12 rising to 99 |

Nothing leaks if you close what you open. The last row is not a leak, it is an unclosed
resource, at about 200 MB and three processes per context.

### Separating waiting from garbage collection

```bash
# one arm per run; without --arm no intervention is applied and the result is empty
for arm in idle-only gc-only gc-plus-idle browser-gc; do
  node --expose-gc leak/gc-isolate.mjs --arm=$arm
done
ITER=200 node --expose-gc leak/gc-check.mjs   # the client side
```

`leak/gc-isolate.mjs` runs 200 iterations then applies one intervention per arm, because a
drop after "forced GC plus a pause" has two possible causes:

| Arm | Round 1 | Round 2 |
|---|---|---|
| 1.5 s idle, no GC | -201 MB | -295 MB |
| forced client GC, no wait | -96 MB | -110 MB |
| forced client GC plus 1.5 s idle | -275 MB | -274 MB |
| `HeapProfiler.collectGarbage` | -176 MB | -152 MB |

Both rounds are in `results/out-gc-isolate.txt`. Waiting freed more than both explicit
collections on every run, which is the finding the guide depends on, though in round 1 only by 25
MB over `HeapProfiler`. Idle alone is the noisiest arm, 201 to 295 MB, while GC plus idle varied
by only 1 MB between rounds. Whether a client GC adds anything to the pause is within the idle
arm's own noise. A browser sampled mid-loop measured 32% and 57% above its size after going idle.

`leak/gc-check.mjs` measures the client side: Node RSS grew 147 to 190 MB over 200
navigations and a forced GC changed it by 0.2 MB, while `heapUsed` stayed flat and reclaimed
normally, so that growth is the allocator's high-water mark rather than retention that keeps
growing.

## heavy/ — do the differences remain at real page weight?

Every other number here comes from an 11 KB page, which is a fair objection.
`heavy/fixture.mjs` is a client-rendered app with a weight setting: cards render from JSON at
runtime, each component holds state and listeners, an executable filler module is parsed and
run so the JS heap is real, and a client-side store holds tens of thousands of rows.

```bash
node heavy/profile-pages.mjs   # calibrate against real sites first
node heavy/run.mjs             # the comparison at three weights
node heavy/selector-cost.mjs   # splits selecting from reading
node heavy/heavy-memory.mjs    # the central claim, 3 repeats at heavy weight
```

Calibration, measured rather than assumed: books.toscrape.com is 542 DOM nodes and a 2.4 MB
heap; react.dev is 1,846 and 11.1 MB; angular.dev is 485 and 16.5 MB. The heavy level is 3,607
nodes and a 27.1 MB heap, so it exceeds every docs SPA profiled, though a production app like
a mail client would be heavier still.

**The central claim is still true, and stronger.** At heavy weight over three repeats, Playwright
measured 636 MB (634-641) against Puppeteer's 634 MB (631-638), CPU time 1.70 against 1.68 seconds,
10 processes each. A 2 MB difference on a 635 MB browser, with overlapping ranges.

**One thing the light fixture did not show.** Puppeteer's walk messages scaled with page size
even though the walk reads a fixed 20 cards. `heavy/selector-cost.mjs` separates selecting
from reading:

| Cards on page | `page.$$()` messages | Playwright locator | Reading 20 |
|---|---|---|---|
| 20 | 80 | 3 | 240 vs 40 |
| 200 | 629 | 3 | 240 vs 40 |
| 600 | 1,832 | 3 | 240 vs 40 |

`$$` creates a handle per match at about three messages each, whether you read that
match or not. A Playwright locator stays lazy and costs three at any size. Reading is flat in
both. At 20 cards this looks like a small constant; at 600 it is 1,832 against 3.

## Between-run variance

Browser memory is the least stable number this harness produces. `results/out-bench-3runs.txt` holds
three independent five-repeat runs, and two more come from the captures taken for the guide's
figures:

```text
TOOL         BROWSER MB across 5 runs         min-max
Playwright   427, 425, 423, 434, 428          423-434
Puppeteer    508, 416, 511, 423, 524          416-524
Selenium     437, 436, 435, 510, 445          435-510
raw BiDi     443, 446, 532, 448, 460          443-532
Lightpanda   10, 10, 10, 10, 10               9.6-10.0
```

Playwright stayed inside an 11 MB range across all five runs. Every other Chromium client measured
about 90 MB above its usual figure at least once, and which one does it changes between runs.
Nothing here identifies the cause and no claim is made about it.

Four of the six client pairs overlap completely. The two that do not, Playwright against Selenium
and Playwright against BiDi, are 1 MB and 9 MB apart, against ranges up to 108 MB wide. A 1 MB
difference at the edge is an artifact, not a real separation.

Walk time and CPU time are steadier than memory, but only one of them ranks anything. Across
the same five runs walk time varied 9 to 17 percent and CPU time 5 to 12:

```text
TOOL         WALK ms across 5 runs        min-max    CPU s                              spread
raw BiDi     55, 53, 52, 51, 47            47-55     1.50, 1.40, 1.41, 1.43, 1.44        7%
Playwright   64, 73, 70, 72, 74            64-74     1.38, 1.42, 1.45, 1.32, 1.33       10%
Puppeteer    82, 88, 80, 78, 77            77-88     1.38, 1.33, 1.38, 1.31, 1.32        5%
Selenium    170, 170, 172, 158, 162      158-172     1.65, 1.58, 1.60, 1.47, 1.47       12%
```

Walk time separates the clients clearly: no two ranges overlap, and the nearest pair is 9 ms
apart. CPU time does not. Three of the six pairs overlap completely, and the two closest pairs
that do not overlap, raw BiDi against Puppeteer and Playwright against Selenium, are 0.02 s
apart each. Across all five runs the four
Chromium clients' browser memory spans 416 MB to 532 MB, which is the range the guide states.

Import cost varies too. `results/out-bench-3runs.txt` records Selenium's at 10 MB, while every
clean clone since has measured about 6.8 MB (`results/out-clean-clone.txt`, whose CPU and browser
columns are too high because the machine was busy, and mean nothing). The guide states 7 to 80
MB.

## gl-useragent-currency.mjs — is the profile's browser version current?

A profile that reports a browser two major versions behind the Chrome people actually run is a
mismatch any site can detect, so the guide's claim about it needs a script rather than a
one-off check:

```bash
GL_TOKEN=... node gl-useragent-currency.mjs
```

```text
profile  advertises  ua
6ab35d   151         Gecko) Chrome/151.0.7922.173 Safari/537.36
6ab35d   151         Gecko) Chrome/151.0.7922.173 Safari/537.36
6ab35d   151         Gecko) Chrome/151.0.7922.173 Safari/537.36

local Chrome       : Google Chrome for Testing 153.0.8010.47  (major 153)
Every profile is 2 majors behind the browser this harness drives.
```

`PATCH /browser/update_ua_to_new_browser_v`, exposed by GoLogin's Node SDK as
`updateUserAgentToLatestBrowser()` and documented at
`/docs/api-reference/profile/get-latest-useragent`, updates them. Creating a profile and keeping
it current are separate steps, the same pattern as canvas mode and the fingerprint refresh, which
is why the guide describes provisioning as a short sequence rather than a single call.

## gl-exit-ip.mjs — what the default exit actually is

The guide says three API-created profiles varied their exit IP. That is measured, but on its own
it suggests the wrong conclusion, so this checks the exit IP of profiles with no proxy attached:

```bash
GL_TOKEN=... node gl-exit-ip.mjs
```

```text
run 1   <exit A>   FI   AS24940 Hetzner Online GmbH
        <exit B>   DE   AS24940 Hetzner Online GmbH
run 2   <exit C>   DE   AS24940 Hetzner Online GmbH
        <exit D>   DE   AS24940 Hetzner Online GmbH
        <exit E>   DE   AS24940 Hetzner Online GmbH
```

The addresses are masked on purpose. The finding is that five sessions returned five different
exit IPs in one datacenter AS, and every part of that is still visible after masking: the count,
the variation, the two countries and the AS. Printing the actual addresses would only help
someone add this provider's exits to a blocklist, which is not a thing this repo should make
easier. Run the script yourself and you will get your own, current values.

Five sessions, five distinct IPs, every one inside the cloud host's own datacenter range. The
variation is real and the classification is datacenter, which is the reason the proxy attachment
exists rather than an argument against it. Measuring a mobile or residential exit needs traffic
on the account, and the dev token used here has zero bytes on all four types, so that half is
described from reading `src/gologin-api.js` rather than measured.

## creepjs-checks.mjs — the same detection checks on local and remote

Implemented from `creepjs/src/headless/index.ts`, read directly rather than from any description
of it. CreepJS reports three groups of checks and the distinction matters: `headless` is definitive,
while `likeHeadless` is heuristic and includes checks that real users also fail.

```bash
node creepjs-checks.mjs                              # local headful and headless
GL_TOKEN=... GL_PROFILE=... node creepjs-checks.mjs  # adds the cloud arm
```

```text
                 screen / avail        webdriver  platform   likeHeadless  headless
local headful    1470x956 / 1470x843   true       MacIntel       0%          50%
local headless    800x600 /  800x600   true       MacIntel       9%         100%
GoLogin cloud    1470x956 / 1470x956   false      Win32         27%           0%
```

The definitive pair is `webDriverIsOn` and `hasHeadlessUA`. Local Chrome fails one check headful
and both headless, because `--headless=new` in Chrome 153 still puts `HeadlessChrome` in the
User-Agent. The cloud profile passes both checks in all four runs.

`webDriverIsOn` is worth reading in the source: it fires when the property is set **and** when it
is `undefined` on a Blink build new enough to have it, so deleting `navigator.webdriver` is itself
a detection signal. Setting it to `false` is the only correct option.

The heuristic checks the cloud profile failed are `prefersLightColor`, `noWebShare` and
`noTaskbar`. The first is a color-scheme preference that millions of real users share. The third
is the one worth changing: `screen` and `availScreen` are equal, while on a desktop with a dock or
taskbar they differ by its height.

## cdc-properties.mjs — the chromedriver detection signal, counted

The guide says chromedriver injects seven `cdc_` properties onto `window` while a plain CDP
connection adds none, and that the string is stable across versions:

```bash
node cdc-properties.mjs
```

```text
via chromedriver : 7 properties
    cdc_adoQpoasnfa76pfcZLmcfl_Array     cdc_adoQpoasnfa76pfcZLmcfl_Symbol
    cdc_adoQpoasnfa76pfcZLmcfl_Object    cdc_adoQpoasnfa76pfcZLmcfl_JSON
    cdc_adoQpoasnfa76pfcZLmcfl_Promise   cdc_adoQpoasnfa76pfcZLmcfl_Window
    cdc_adoQpoasnfa76pfcZLmcfl_Proxy
via plain CDP    : 0 properties
```

The property names are the shimmed globals, which is why a page can find them by prefix without
knowing the suffix. The suffix itself is a build constant, not a per-session value.

Checked against every chromedriver on the reference machine, `strings` finds the identical
`cdc_adoQpoasnfa76pfcZLmcfl` in 131.0.6778.264, 133.0.6943.141, 134.0.6998.88, 134.0.6998.165,
135.0.7049.95, 138.0.7204.94 and 153.0.8010.47.

## runtime-enable-tell.mjs — which messages are themselves a detection signal

Found by reading patchright's source rather than by measuring: it names avoiding `Runtime.enable`
as its single biggest patch, because a page can detect that CDP domain being enabled. Every other
script here treats a CDP message as a cost in milliseconds. This asks which ones make you
detectable:

```bash
node runtime-enable-tell.mjs
```

```text
playwright  34 commands   Runtime.enable x3   (+ Page, Log, Network x3)
puppeteer   38 commands   Runtime.enable x1   (+ Network, Page, Audits, Performance, Log, WebMCP)
```

Both mainstream clients enable it when they connect. Patchright avoids it by running its scripts
in isolated execution contexts instead, and patches the Playwright driver's launch flags
(`--disable-blink-features=AutomationControlled` added, `--enable-automation` removed), which is
exactly why its `navigator.webdriver` patch does not work after a `connectOverCDP` to a browser
you started yourself. The guide reports that behavior; the source explains it.

## gl-fingerprint-refresh.mjs — what the fingerprint refresh actually changes

`src/gologin-api.js` in the SDK exposes `refreshProfilesFingerprint()`, which PATCHes
`/browser/fingerprints`, and it is documented at
`/docs/api-reference/profile/refresh-profile-fingerprint`:

```bash
GL_TOKEN=... node gl-fingerprint-refresh.mjs
```

```text
PATCH /browser/fingerprints -> 200
re-rolled:  canvasNoise, webGLNoise, renderer, vendor, cores, deviceMemory, resolution
unchanged:  canvas.mode, userAgent

distinct across 3 profiles    before -> after
  renderer                      3 -> 3
  cores                         2 -> 3
  resolution                    1 -> 3
```

Resolution is the one that matters: 7 of 7 profiles created through `/browser/quick` had
one shared value while declaring Windows 11, and `screen.width` is readable by any page. The
refresh call gives three distinct, platform-plausible values. It does not change `canvas.mode`, so
you need both steps.

The shared resolution is set server-side, not leaked from the host: `getOsAdvanced()` in
`src/utils/common.js` returns only `{os, osSpec}`, and the SDK sends no screen data at creation.

## gl-fingerprint.mjs — does a remote profile actually change identity?

The local scripts prove that separate contexts and separate Chrome browsers share one identity.
This runs the same canvas test against separate remote profiles, so the guide's recommendation
is measured rather than asserted.

```bash
GL_TOKEN=... node gl-fingerprint.mjs                      # creates and deletes 3 default profiles
GL_TOKEN=... GL_PROFILES=id1,id2,id3 node gl-fingerprint.mjs  # or test profiles you already have
```

Three profiles created through the API varied their exit IP, WebGL renderer string, and
`hardwareConcurrency`, and reported `navigator.webdriver` as `false` while every local client
reported `true`. They still shared one canvas hash, because new profiles have canvas, WebGL,
and clientRects masking disabled by default, while each has a per-profile noise value:

```json
"canvas": { "mode": "off", "noise": 0.4832847 }
```

Setting those three fields to `noise` and re-running the same test returned three
distinct canvas hashes. Same profiles, same test, one config change. Both `/browser/quick`
and `/browser/custom` default them off, so profiles created by a script share one canvas until
each profile is patched. This is worth knowing before you create many profiles, not after they
are blocked.

## gl-session-cost.mjs — what an open session costs, and how a refusal looks

This opens cloud sessions until the account limit refuses one, samples client RSS after
each, and then asks for one more over both a plain GET and a WebSocket upgrade, because the two
paths refuse differently. Run it with
`GL_TOKEN=... node --expose-gc gl-session-cost.mjs` (the GC flag makes the RSS samples
comparable).

Three runs, kept in `results/out-gl-session-cost.txt`:

```text
RUN   BASELINE   1 SESSION   2         3         4         DELTA AT 4
1     170.0 MB   172.3 MB    172.5     172.8     173.0     +3.0 MB
2     168.6 MB   170.3 MB    170.8     171.2     159.2      -9.5 MB
3     171.5 MB   173.4 MB    173.8     161.8     162.0      -9.5 MB
```

Keeping four sessions open costs no measurable client memory. The largest change was 3.0 MB and
two runs finished *below* their own baseline, because a garbage collection during the run freed
more than the sessions ever used. No local browser process starts at any point.

The refusal differs by path, and did so on all three runs:

```text
plain GET          403   X-Error-Reason: {"statusCode":403,"message":"You've reached max parallel cloud launche…
WebSocket upgrade  503   no X-Error-Reason, no body
```

The code a retry loop actually sees depends on how it connects. A client using
`connectOverCDP` gets the `503` with nothing to parse, which is why the preflight GET is worth
doing before connecting rather than after a failure.

## gl-remote-latency.mjs — what the endpoint actually costs in latency

This creates one profile, connects with `playwright-core` over
`connectOverCDP`, and on each repeat measures the CDP round trip (`Browser.getVersion`, eleven
samples, median), the connection, the navigation, a 40-read locator walk and the same reads batched
into one evaluation. The walk matches `bench.mjs`: 20 cards, two fields each. Run it with
`GL_TOKEN=... node gl-remote-latency.mjs`.

Nine runs across two independent sessions, on books.toscrape.com, kept in
`results/out-gl-latency.txt`:

```text
METRIC                       MEDIAN      MIN-MAX      n
CDP round trip                236 ms      227-248      9
walk, 40 locator reads       9941 ms   9283-10135      9
same read, one evaluation     484 ms      466-589      9
first connect                5509 ms    5380-5637      2
reconnect                    1538 ms    1517-1803      7
```

The walk costs 249 ms per read against a 236 ms round trip, so each locator read costs one round
trip, the same result as the local benchmark, now over a real network distance. Batching it into
one evaluation reduces it by a factor of 21.

Two caveats. The local 64 ms the guide compares against comes from `latency-table.txt` on the
local fixture, while the remote walk runs on books.toscrape.com, so the pages differ even though
the read pattern does not; the comparison is of round-trip cost, which is the largest cost in
both.
And every number here is one machine's distance to one endpoint on one day, not a property of the
product.

## gl-session-release.mjs — does closing the client free the parallel slot?

Whether closing the client alone releases a parallel slot, with no explicit stop call. The other
scripts stop their sessions explicitly, so this is the one that observes release in isolation.

The test fills the parallel-session limit, then releases exactly one session by closing the
client only, with no stop call, and preflights the freed slot on a timer:

```bash
GL_TOKEN=... node gl-session-release.mjs   # creates 6 default profiles, deletes them on exit
# MAX_SESSIONS=<n> if your plan allows more than 5 parallel sessions; GL_PROFILES=... to use your own
```

```json
{ "ceilingReachedAt": 4, "sessionsHeld": 4, "closedWithoutDelete": "d3467c",
  "slotAfter0s":  { "status": 200 },
  "slotAfter5s":  { "status": 200 },
  "slotAfter20s": { "status": 200 } }
```

The fifth connection is refused with `403` and `X-Error-Reason: You've reached max parallel clo…`,
which confirms the limit is real and that the preflight can detect a full account. Closing one
client then frees the slot immediately, and it stays free. Explicit deletion remains useful for
removing stored profiles, which is a separate concern from releasing a running session.

## local-patch-limit.mjs — where local patching actually stops

The guide shows that patchright's launch-time patch stops working when you connect to a running
browser. On its own, that suggests "local patching does not work", which is not what was
measured. This finds the real limit by applying a CDP script hook to a browser the process did
not launch:

```bash
node local-patch-limit.mjs
```

```json
{ "connectedUnpatched": { "webdriver": true  },
  "connectedPatched":   { "webdriver": false } }
```

`Page.addScriptToEvaluateOnNewDocument`, which puppeteer exposes as `evaluateOnNewDocument`,
runs before page script on a connection rather than at launch, so the JavaScript-visible values
can be changed on a browser you attached to. That is the part local work can do.

What it cannot change is measured by `tls-probe.mjs`: JA4 and HTTP/2 were byte-identical
headless and headful, and differed only when the engine changed. Those are set by the network
stack below the JavaScript VM, so no in-page hook changes them, and `ja3-stability.mjs` shows
JA3 cannot be used to check your work either.

## make-latency-table.mjs — the latency table is generated, not written

`latency-table.txt` is derived from the three bench runs in `results/`, so the figure and its
evidence always match, and `verify-all.sh` fails if the committed copy ever differs:

```bash
node make-latency-table.mjs
```

One thing to know when reading the two figures together. The walk times in `fig-1` come from a
later `bench.mjs` run than the `RTT 0ms` column here, so they differ by a few milliseconds on the
same measurement. That is the run-to-run variance this README documents, not a contradiction, and
the table's own 0 ms column is the one to compare against its 20 ms and 60 ms columns.

Two figures the guide quotes are derived from this table rather than printed in it, so here is
the arithmetic. At 60 ms, dividing each walk by its message count gives the cost of one message:
raw BiDi 2,762 / 41 = 67.4 ms, Playwright 2,821 / 46 = 61.3, Selenium 5,719 / 81 = 70.6, and
Puppeteer 16,292 / 320 = 50.9. That is the guide's "50 to 71 ms of elapsed time" per message, one
round trip each. And Puppeteer's 60 ms walk against its 60 ms single evaluation is
16,292 / 65 = 250.6, the "factor of 251".

## bidi-load-cost.mjs — the dash in the results table

`bench.mjs` prints `-` for the BiDi row's import cost, because that arm was never instrumented for
it while every other row reports RSS added by importing its client. This measures it the same
way, in a new process per sample, since a second import is free:

```bash
node bidi-load-cost.mjs
```

```text
raw     14.0 MB   the ws package alone, a hand-written BiDi client
armed   26.3 MB   ws plus selenium-webdriver, which the arm uses to spawn
                  chromedriver and negotiate webSocketUrl before taking control of the socket
```

The guide reports 26 MB, because that is what the benchmarked arm actually loads. It cannot be
measured inside `bench.mjs` honestly: that process imports `ws` at the top for the counting
proxy, so an in-harness measurement would show only the selenium difference and undercount by
about 14 MB.

## lp-vs-chrome.mjs — does Lightpanda build the same DOM?

Lightpanda's main result is 10 MB against Chromium's 416 to 532. The question that decides
whether that is usable is whether it renders the same page. This drives the same three sites
through both engines in one session, three repeats each, and compares node counts:

```bash
node lp-vs-chrome.mjs
```

```text
react.dev    chrome  1846 nodes   lightpanda  1847   ratio 1.00
angular.dev  chrome   485 nodes   lightpanda   385   ratio 0.79
vuejs.org    chrome   619 nodes   lightpanda   754   ratio 1.22
```

One of three matches Chrome node for node. The other two differ in opposite directions:
Lightpanda under-renders angular.dev and over-renders vuejs.org, so the difference is a
different DOM rather than simply an unfinished one.

angular.dev has measured both 485 and 385 for Lightpanda on different days, with Chrome steady
at 485, so treat that row as unstable. The page or the engine changes between runs, and this
script cannot say which. Repeat it before quoting it.

## tls-probe.mjs and ja3-stability.mjs — the network layer

A TLS handshake and an HTTP/2 preface are fingerprintable before a single byte of JavaScript
runs, so these ask which of them automation actually changes.

```bash
node tls-probe.mjs        # Chrome headless, Chrome headful, Lightpanda, curl
node ja3-stability.mjs    # 3 repeats per mode, to separate signal from GREASE
```

| Client | JA4 | HTTP/2 |
|---|---|---|
| Chrome headless, Playwright | `t13d1518h2_8daaf6152771_4980c97edce0` | `52d84b11737d980aef856699f885ca86` |
| Chrome headful, Playwright | identical | identical |
| Lightpanda | `t13d1711h2_5b57614c22b0_5894756fee65` | `55cb2bd667724e6d46cc3c8dd15d50de` |
| curl | `t13d497h2_0d8feac7bc37_7395dae3b2f3` | `64a832f547be33249bf4d33e8a46c5dc` |

**Headless changes nothing here.** JA4 and the HTTP/2 fingerprint are byte-identical headless and
headful, so TLS and HTTP/2 do not show that a browser is headless. The User-Agent does: the
server receives `HeadlessChrome` in every request header (the `ua` column of `tls-probe.mjs`),
and page script reads it too, along with `navigator.webdriver`. Effort spent on TLS to hide
headless is spent in the wrong place.

**JA3 is noise for Chrome.** `ja3-stability.mjs` ran three repeats of each mode and returned
six distinct JA3 hashes from six runs, while JA4 stayed at one value per mode and matched across
modes. JA3 does not normalize the GREASE values Chrome randomizes per connection. Anyone
comparing JA3 hashes to verify a stealth setup is comparing random values.

**Lightpanda is also detectable at the network layer.** Its JA4 and HTTP/2 fingerprints differ
from Chrome's, and no User-Agent override changes that. This makes the guide's trade-off
clearer: Lightpanda not only identifies itself in the User-Agent, it also does not perform the
TLS handshake the way Chrome does.

## Cypress — the one row measured on disk

Cypress runs its tests inside the page, so the cost table's other columns do not apply to it.
The guide gives its install size instead:

```bash
npm i cypress@16.1.0                        # the binary downloads into the Cypress cache
du -sh node_modules
du -sh "$(npx cypress cache path)/16.1.0"
```

`results/out-cypress-size.txt` holds the output: 30 MB of `node_modules` and a 641 MB binary.
`verify-all.sh` does not run this, because it downloads the Cypress binary.

## Environment the published numbers came from

Apple M3, eight cores, 16 GB RAM, macOS 26.6.2, Node v25.9.0, Google Chrome for Testing
153.0.8010.47 with matching chromedriver, playwright-core 1.63.0, puppeteer-core 25.11.0,
selenium-webdriver 4.49.0, cypress 16.1.0, and Lightpanda 1.0.0-nightly.

Raw output for every run the guide quotes is in `results/`.

## Overrides

`CHROME_PATH`, `CHROMEDRIVER_PATH` and `LIGHTPANDA_PATH` point the harness at binaries you
already have.
