# browser-automation-bench

Reproduces every figure in *Best Browser Automation Tools in 2026: Benchmark Guide*.

Drives one pinned Chrome build from Playwright, Puppeteer, Selenium Classic, and a raw WebDriver
BiDi client, plus Lightpanda as a non-Chromium engine, and reports what each costs: client memory,
browser memory, process count, CPU, and protocol round trips for an identical extraction task.

## Setup

`package.json` pins the client versions the guide reports and the browser is pinned here, so
that a fresh checkout reproduces the published numbers rather than whatever shipped this week:

```bash
npm install
npx @puppeteer/browsers install chrome@153.0.8010.47 --path ./.browsers
npx @puppeteer/browsers install chromedriver@153.0.8010.47 --path ./.browsers
```

Every script imports from `lib/`, which holds the Chrome launcher, the `phys_footprint` and CPU
readers, the fixture server, and the counting WebSocket proxy. The probes do not run without it.

Lightpanda is optional. Install it and the fifth row appears; skip it and the row is omitted:

```bash
curl -fsSL https://pkg.lightpanda.io/install.sh | bash
export LIGHTPANDA_PATH=~/.local/bin/lightpanda
```

## Run

```bash
node bench.mjs                      # local, 3 repeats
RTT=60 node bench.mjs               # inject 60 ms round-trip latency
REPEATS=5 RTT=20 node bench.mjs     # more repeats, 20 ms latency
```

Results also land in `bench-results.json`.

## What it measures differently

**Browser memory is `phys_footprint` on macOS and PSS on Linux, never a sum of `ps` RSS.**
Summing RSS across a Chromium process tree counts the shared binary image once per process. On
the reference machine that inflated the browser figure by 2.3x to 3.0x across runs.

**Protocol messages are counted on the wire.** A proxy sits between the automation client and
the browser and counts every frame, so the number is what actually crossed the socket rather
than what the API surface suggests. The same proxy injects the `RTT` delay, on both legs, so no
arm pays half the round trip the others pay.

**CPU comes from Chrome's own accounting.** `SystemInfo.getProcessInfo` lives on the browser-level
CDP session, not a page session. Lightpanda does not implement it, so its CPU comes from `ps`.

**Each client runs in its own process.** Importing all four into one process makes every
client-memory reading cumulative and silently reports the wrong number for every client after
the first.

**The RTT injection is software, and was checked against real TCP shaping.** Toxiproxy with
30 ms each way, 10 ms jitter, and a 1 MB/s ceiling agreed with this harness within 2% at 60 ms.
Jitter did not change the ranking, and the bandwidth cap cost Playwright about 7% and Puppeteer
nothing, which is what the 493 KB against 98 KB upload difference predicts.

## mcp-token-cost.mjs

Measures what a coding agent's page read costs in tokens. It drives Playwright MCP over
stdio JSON-RPC with no model in the loop, so the numbers belong to the tool rather than to
any model, and it tokenizes the payloads rather than estimating from character counts.

```bash
npm i @playwright/mcp gpt-tokenizer
node mcp-token-cost.mjs
```

`browser_snapshot` and a targeted `browser_evaluate` each cost three CDP messages, so the
wire cost is identical. The snapshot tokenized to 10x to 12x the evaluation for the same
records, because it describes every element whether the caller needed it or not.

Two things this gets right that are easy to get wrong. The extractor is **per host**, so the
comparison runs against a real extraction rather than an empty array from a selector that
does not match. And the token counts come from a real tokenizer: a chars/4 estimate
overstated the ratio by up to a third on these pages.

## concurrency-sweep.mjs

Sweeps 1, 2, 4, 8, and 16 concurrent units across the two architectures people actually
choose between: N browser contexts inside one browser, and N separate browsers. Reports
browser memory, process count, CPU, and wall time at each level.

```bash
node concurrency-sweep.mjs
```

Both curves are linear. A context costs about 213 MB after a 397 MB first; a separate
browser costs about 400 MB flat. The formula `397 + 213 * (n - 1)` predicted the measured
16-context figure within 2%. Separate browsers finish faster because they do not contend
on one browser process, and cost roughly 1.75x the memory and 2.6x the CPU to do it.

## isolation-probe.mjs and canvas-verify.mjs

What that extra memory does and does not buy. `isolation-probe.mjs` compares nine
fingerprint surfaces across two contexts in one browser against two separate browsers, and
checks whether one context can read another's `localStorage`. `canvas-verify.mjs` hashes a
canvas render across three browsers with three separate user data directories.

```bash
node isolation-probe.mjs
node canvas-verify.mjs
```

Contexts isolate storage. Neither contexts nor separate browsers isolate the machine: all
four surfaces produced one canvas hash, with identical `hardwareConcurrency`,
`deviceMemory`, and `platform`. Process separation buys crash containment, not identity.

## edge/ — where one evaluation stops working

The guide tells readers to collapse a locator walk into a single in-page evaluation. This
measures the boundary. `edge/fixture.mjs` serves 35 records across seven render paths a real
page actually uses: server-rendered, deferred by 800 ms, gated behind a click, inside an open
shadow root, inside a closed one, and inside same-origin and cross-origin iframes.

```bash
node edge/probe.mjs          # how far one evaluation gets
node edge/closed-shadow.mjs  # page script vs Playwright locator vs CDP
```

One evaluation at `domcontentloaded` finds 5 of 35. Waiting gets 10, clicking 15, walking open
shadow roots 20. Each iframe needs its own evaluation, and the two iframes hold 5 each, so page
script doing everything it can reaches 30 of 35: `reachableWalkingOpenShadowInEveryFrame`.

The probe used to print only `reachableAcrossAllFrames`, which is 25, because it enumerated each
frame with a plain `querySelectorAll` and so missed the 5 records behind the main frame's open
shadow host. That was the probe under-reporting, not a different result: it now counts each frame
both ways and prints 25 and 30 side by side. The guide states 30.

The closed shadow root's 5 are invisible
to page script (`shadowRoot` is `null`) and to a Playwright locator, but `DOM.getDocument` with
`pierce: true` returns all five over CDP, so the protocol is strictly more capable than the
page script the optimization runs in.

## leak/ — what a long run actually does

"It leaks, restart the browser every N pages" is folklore in every comparison article.
`leak/fixture.mjs` serves a page with the things that genuinely leak: event listeners holding
DOM references in closures, a running timer, and 200 detached nodes. `leak/run.mjs` loops the
same extraction 200 times in four patterns and samples browser memory, process count, client
RSS, and JS heap as it goes.

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
| new page, closed | 577 to 953 MB, slow creep | 10 rising to 20, then flat |
| new context, never closed | 708 MB to 6.5 GB by iteration 30 | 12 rising to 99 |

Nothing leaks if you close what you open. The last row is not a leak, it is an unclosed
resource, at roughly 200 MB and three processes per context.

### The measurement trap, and isolating it

`leak/gc-isolate.mjs` runs 200 iterations then applies one intervention per arm, because a
drop after "forced GC plus a pause" has two possible causes:

| Arm | Browser delta |
|---|---|
| 1.5 s idle, no GC | -270 MB |
| forced client GC, no wait | -113 MB |
| forced client GC plus 1.5 s idle | -273 MB |
| `HeapProfiler.collectGarbage` | -144 MB |

Idle time is the cause. Adding a client GC on top of the wait changed nothing (-273 against
-270), and waiting beat both explicit collections. A browser sampled mid-loop over-reports by
about a third. `leak/gc-check.mjs` covers the client side: Node RSS grew 147 to 190 MB over 200
navigations and a forced GC moved it 0.2 MB, while `heapUsed` stayed flat and reclaimed
normally, so that growth is allocator high-water rather than retention that keeps climbing.

## heavy/ — do the deltas survive real page weight?

Every other number here comes from an 11 KB page, which is a fair objection.
`heavy/fixture.mjs` is a client-rendered app with a weight dial: cards render from JSON at
runtime, each component holds state and listeners, an executable ballast module is parsed and
run so the JS heap is real, and a client-side store holds tens of thousands of rows.

```bash
node heavy/profile-pages.mjs   # calibrate against real sites first
node heavy/run.mjs             # the comparison at three weights
node heavy/selector-cost.mjs   # splits selecting from reading
node heavy/heavy-memory.mjs    # the central claim, 3 repeats at heavy weight
```

Calibration, measured rather than assumed: books.toscrape.com is 542 DOM nodes and a 2.4 MB
heap; react.dev is 1,846 and 11.1 MB; angular.dev is 485 and 16.5 MB. The heavy tier is 3,607
nodes and a 27.1 MB heap, so it exceeds every docs SPA profiled, though a production app like
a mail client would be heavier still.

**The central claim holds and strengthens.** At heavy weight over three repeats, Playwright
measured 636 MB (634-641) against Puppeteer's 634 MB (631-638), CPU 1.70 against 1.68 seconds,
10 processes each. A 2 MB difference on a 635 MB browser, with overlapping ranges.

**One thing the light fixture hid.** Puppeteer's walk messages scaled with page size even
though the walk reads a fixed 20 cards. `selector-cost.mjs` splits the cause out:

| Cards on page | `page.$$()` messages | Playwright locator | Reading 20 |
|---|---|---|---|
| 20 | 80 | 3 | 240 vs 40 |
| 200 | 629 | 3 | 240 vs 40 |
| 600 | 1,832 | 3 | 240 vs 40 |

`$$` materialises a handle per match at roughly three messages each, whether you read that
match or not. A Playwright locator stays lazy and costs three at any size. Reading is flat in
both. At 20 cards this looks like a modest constant; at 600 it is 1,832 against 3.

## Between-run variance, and why the guide now states a range

Browser memory is the least stable number this harness produces. `out-bench-3runs.txt` holds
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

Playwright stayed inside an 11 MB band across all five runs. Every other Chromium client landed
about 90 MB above its usual figure at least once, and which one does it changes between runs.
After three runs it looked like Playwright and Selenium were both stable, which was over-fitting
to three samples: the fourth run put Selenium at 510 MB. Nothing here identifies the cause and no
claim is made about it.

Four of the six client pairs overlap outright. The two that do not, Playwright against Selenium
and Playwright against BiDi, miss by 1 MB and 9 MB against bands up to 108 wide. An earlier
version of this file said the variance inside a single client is larger than the gap between
clients: true of Puppeteer, false of Playwright, whose 11 MB band sits well inside the 81 MB
spread between client medians. Missing by 1 MB is an edge artifact, not a separation.

Walk and CPU are steadier, and there the ranking does survive. Across the same five runs walk
moved 9 to 17 percent and CPU 5 to 12, but the clients do not overlap at all:

```text
TOOL         WALK ms across 5 runs        min-max    CPU s                              spread
raw BiDi     55, 53, 52, 51, 47            47-55     1.50, 1.40, 1.41, 1.43, 1.44        7%
Playwright   64, 73, 70, 72, 74            64-74     1.38, 1.42, 1.45, 1.32, 1.33       10%
Puppeteer    82, 88, 80, 78, 77            77-88     1.38, 1.33, 1.38, 1.31, 1.32        5%
Selenium    170, 170, 172, 158, 162      158-172     1.65, 1.58, 1.60, 1.47, 1.47       12%
```

An earlier draft of the guide said the four Chromium rows land between 430 MB and 446 MB. That
was one run's medians presented as the general result, and it is not reproducible: five runs
span 416 MB to 532 MB.

## gl-useragent-currency.mjs — is the profile's browser version current?

A profile that advertises a browser two majors behind the fleet actually running is a mismatch
anyone can read, so the guide's claim about it needs a probe rather than a one-off check:

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

`PATCH /browser/update_ua_to_new_browser_v`, exposed by the SDK as
`updateUserAgentToLatestBrowser()` and documented at
`/docs/api-reference/profile/get-latest-useragent`, moves them forward. Creation and currency
are separate steps, the same shape as canvas mode and the fingerprint refresh, which is why the
guide describes provisioning as a short sequence rather than a single call.

The first version of this probe parsed the local version with `/Chrome\/(\d+)/`, which does not
match `Google Chrome for Testing 153.0.8010.47`. The local major came back `undefined` and the
verdict line printed the opposite of the data sitting above it. Worth recording: the table was
right and the conclusion was wrong, which is the failure mode a summary line invites.

## gl-exit-ip.mjs — what the default exit actually is

The guide says three API-created profiles varied their exit IP. That is measured, but on its own
it invites the wrong conclusion, so this reads the exit of profiles with no proxy attached:

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
exit IPs in one datacenter AS, and every part of that survives masking: the count, the variation,
the two countries and the AS. Printing the actual addresses would only help someone add this
provider's exits to a blocklist, which is not a thing this repo should make easier. Run the probe
yourself and you will get your own, current values.

Five sessions, five distinct IPs, every one inside the cloud host's own datacenter range. The
variation is real and the classification is datacenter, which is the reason the proxy attachment
exists rather than an argument against it. Measuring a mobile or residential exit needs traffic
on the account, and the dev token used here has zero bytes on all four classes, so that half is
described from `src/gologin-api.js` rather than measured.

One session in six returned a `503` on connect and the next run was clean, so it is recorded here
and not in the guide. One observation is not a finding.

## creepjs-checks.mjs — the same detection probe on local and remote

Implemented from `creepjs/src/headless/index.ts`, read directly rather than from any description
of it. CreepJS scores three families and the distinction matters: `headless` is definitive, while
`likeHeadless` is heuristic and includes checks a real user trips.

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

The definitive pair is `webDriverIsOn` and `hasHeadlessUA`. Local Chrome fails one headful and
both headless, because `--headless=new` in Chrome 153 still ships `HeadlessChrome` in the
User-Agent. The cloud profile fails neither, repeated across four runs.

`webDriverIsOn` is worth reading in the source: it fires when the property is set **and** when it
is `undefined` on a Blink build new enough to have it, so deleting `navigator.webdriver` is itself
a tell. Setting it to `false` is the only correct move.

The heuristic hits on the cloud profile are `prefersLightColor`, `noWebShare` and `noTaskbar`.
The first is a colour-scheme preference that millions of real users share. The third is the one
worth setting: `screen` and `availScreen` are equal, where a desktop with a dock or taskbar
differs by its height.

## cdc-properties.mjs — the chromedriver tell, counted

The guide says chromedriver injects seven `cdc_` properties onto `window` where a plain CDP
connect leaves none, and that the string is stable across versions. None of that had a script
behind it until now:

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
135.0.7049.95, 138.0.7204.94 and 153.0.8010.47. An earlier draft of the guide said "120, 131 and
153"; 120 was never present here and was never checked, so the guide now states the range that
was.

## runtime-enable-tell.mjs — which messages are themselves a tell

Found by reading patchright's source rather than by measuring: it names avoiding `Runtime.enable`
as its single biggest patch, because a page can detect that CDP domain being enabled. Every other
probe here treats a CDP message as a cost in milliseconds. This asks which ones cost you cover:

```bash
node runtime-enable-tell.mjs
```

```text
playwright  34 commands   Runtime.enable x3   (+ Page, Log, Network x3)
puppeteer   38 commands   Runtime.enable x1   (+ Network, Page, Audits, Performance, Log, WebMCP)
```

Both mainstream clients enable it on connect. Patchright avoids it by running script through
isolated execution contexts instead, and patches the Playwright driver's launch flags
(`--disable-blink-features=AutomationControlled` added, `--enable-automation` removed), which is
exactly why its `navigator.webdriver` patch does not survive a `connectOverCDP` to a browser you
started yourself. The guide reports that behaviour; the source explains it.

## gl-fingerprint-refresh.mjs — what the fingerprint refresh actually re-rolls

`src/gologin-api.js` in the SDK exposes `refreshProfilesFingerprint()`, which PATCHes
`/browser/fingerprints`, and it is documented at
`/docs/api-reference/profile/refresh-profile-fingerprint`.

An earlier version of this file called the endpoint undocumented. That was wrong: one docs page
had been read and the conclusion generalised to all 213 of them. The measurement below stands,
the claim about the documentation did not. The guide originally told readers to hand-patch `canvas.mode` on each
profile, which is the worse path when a documented one exists:

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

Resolution is the one that matters: 7 of 7 profiles created through `/browser/quick` came back at
one shared value while declaring Windows 11, and `screen.width` is readable by any page. The
refresh call gives three distinct, platform-plausible values. It does not flip `canvas.mode`, so
the two steps are complementary rather than redundant.

A first reading of this looked like the host's own resolution leaking through. It is not:
`getOsAdvanced()` in `src/utils/common.js` returns only `{os, osSpec}`, and the SDK sends no screen
data at creation, so the value is server-side. Checking the source is what caught the wrong
mechanism before it was written down.

## gl-fingerprint.mjs — does a remote profile actually change identity?

The local probes prove that separate contexts and separate browsers share one identity. This
runs the same canvas probe against separate remote profiles, so the guide's recommendation is
measured rather than asserted.

```bash
GL_TOKEN=... GL_PROFILES=id1,id2,id3 node gl-fingerprint.mjs
```

Three profiles created through the API varied their exit IP, WebGL renderer string, and
`hardwareConcurrency`, and reported `navigator.webdriver` as `false` where every local client
reported `true`. They still shared one canvas hash, because profiles ship with canvas, WebGL,
and clientRects masking disabled while carrying a per-profile noise value:

```json
"canvas": { "mode": "off", "noise": 0.4832847 }
```

Flipping those three fields to `noise` and re-running the identical probe returned three
distinct canvas hashes. Same profiles, same probe, one config change. Both `/browser/quick`
and `/browser/custom` default them off, so a scripted fleet inherits one canvas until the
profile is patched. This is worth knowing before the fleet is built rather than after it is
blocked.

## gl-session-cost.mjs — what an open session costs, and how a refusal looks

Two claims in the guide had nothing behind them. The first was that four open sessions cost
97.9 MB of client RSS; no script measured client memory. The second was that the WebSocket
upgrade is refused with a `400`; `gl-session-release.mjs` only ever probed the plain GET path,
which answers `403`, so no `400` was ever observed. This script opens sessions until the
account ceiling refuses one, samples client RSS after each, and then asks for one more over
both paths so the two codes can be compared side by side. Run it with
`GL_TOKEN=... node --expose-gc gl-session-cost.mjs` (the GC flag makes the RSS samples
comparable).

Three runs, kept in `out-gl-session-cost.txt` and `out-gl-session-cost-2.txt`:

```text
RUN   BASELINE   1 SESSION   2         3         4         DELTA AT 4
1     170.0 MB   172.3 MB    172.5     172.8     173.0     +3.0 MB
2     168.6 MB   170.3 MB    170.8     171.2     159.2      -9.5 MB
3     171.5 MB   173.4 MB    173.8     161.8     162.0      -9.5 MB
```

Holding four sessions costs no measurable client memory. The largest delta was 3.0 MB and two
runs finished *below* their own baseline, because a garbage collection during the run freed
more than the sessions ever held. No local browser process starts at any point. The guide's
97.9 MB was wrong in the direction that understated the case: the whole point of moving the
browser off the machine is that the client keeps almost nothing, and 97.9 MB suggested
otherwise.

The refusal differs by path, and did so on all three runs:

```text
plain GET          403   X-Error-Reason: {"statusCode":403,"message":"You've reached max parallel cloud launche…
WebSocket upgrade  503   no X-Error-Reason, no body
```

So the guide's `400` was wrong, and the code a retry loop actually sees depends on how it
connects. A client using `connectOverCDP` gets the `503` with nothing to parse, which is why
the preflight GET is worth doing before a connect rather than after a failure.

This also revises a note in the section below. `gl-session-release.mjs` recorded one `503` on
connect in six sessions and treated it as a transient, on the grounds that one observation is
not a finding. That was the right call at the time, but `503` is now the observed refusal code
on the WebSocket path across three runs, so that session was most likely the ceiling rather
than noise.

## gl-remote-latency.mjs — what the endpoint actually costs in latency

An earlier draft of the guide quoted four remote-latency figures with no probe behind them. This
script is that probe. It creates one profile, connects with `playwright-core` over
`connectOverCDP`, and on each repeat measures the CDP round trip (`Browser.getVersion`, eleven
samples, median), the connect, the navigation, a 40-read locator walk and the same read collapsed
into one evaluation. The walk mirrors `bench.mjs`: 20 cards, two fields each. Run it with
`GL_TOKEN=... node gl-remote-latency.mjs`.

Nine runs across two independent sessions, on books.toscrape.com, kept in `out-gl-latency.txt`
and `out-gl-latency-2.txt`:

```text
METRIC                       MEDIAN      MIN-MAX      n
CDP round trip                236 ms      227-248      9
walk, 40 locator reads       9941 ms   9283-10135      9
same read, one evaluation     484 ms      466-589      9
first connect                5509 ms    5380-5637      2
reconnect                    1538 ms    1517-1803      7
```

The walk costs 249 ms per read against a 236 ms round trip, so each locator read is one round
trip and the remote walk is the round-trip thesis restated at distance. Collapsing it into one
evaluation is a factor of 21.

The four figures the guide used to carry were wrong, and three of them were wrong in the
direction that flatters nobody: 270 ms against a measured 227-248, an 11,799 ms walk against
9,283-10,135, and a 5,804 ms cold connect against 5,380-5,637. The fourth, 616 ms, was presented
as the counterpart to the cold connect and understates it: a reconnect measured 1,517 to 1,803 ms.
Only the collapsed read, quoted at 527 ms, fell inside its measured band. The guide now states
the medians above.

Two caveats. The local 64 ms the guide compares against comes from `latency-table.txt` on the
local fixture, while the remote walk runs on books.toscrape.com, so the pages differ even though
the read shape does not; the comparison is of round-trip cost, which is what dominates both.
And every number here is one machine's distance to one endpoint on one day, not a property of the
product.

## gl-session-release.mjs — does closing the client free the parallel slot?

This probe exists because an earlier draft asserted that closing the client did not reliably
release a session. That claim was never measured: every other script called
`DELETE /browser/{id}/web` after closing, so the release path was never observed in isolation.

The test fills the parallel-session ceiling, then releases exactly one session by client close
alone, with no stop call, and preflights the freed slot on a timer:

```bash
GL_TOKEN=... node gl-session-release.mjs
```

```json
{ "ceilingReachedAt": 4, "sessionsHeld": 4, "closedWithoutDelete": "d3467c",
  "slotAfter0s":  { "status": 200 },
  "slotAfter5s":  { "status": 200 },
  "slotAfter20s": { "status": 200 } }
```

The fifth connect is refused with `403` and `X-Error-Reason: You've reached max parallel clo…`,
which confirms the ceiling is real and that the preflight can detect a full account. Closing one
client then frees the slot immediately, and it stays free. The original claim was wrong, and the
guide now states the measured behaviour. Explicit deletion remains useful for removing stored
profiles, which is a separate concern from releasing a running session.

## local-patch-limit.mjs — where local patching actually stops

The guide shows patchright's launch-time patch vanishing on a connect. Left alone that reads as
"local patching does not work", which is not what was measured. This finds the real ceiling by
applying a CDP script hook to a browser the process did not launch:

```bash
node local-patch-limit.mjs
```

```json
{ "connectedUnpatched": { "webdriver": true  },
  "connectedPatched":   { "webdriver": false } }
```

`Page.addScriptToEvaluateOnNewDocument`, which puppeteer exposes as `evaluateOnNewDocument`,
runs before page script on a connection rather than at launch, so the JavaScript surfaces are
reachable on a browser you attached to. That is the part local work can do.

What it cannot reach is measured by `tls-probe.mjs`: JA4 and HTTP/2 came back byte-identical
headless and headful, and moved only when the engine changed. Those are set by the network
stack below the JavaScript VM, so no in-page hook alters them, and `ja3-stability.mjs` shows
JA3 cannot be used to check your work either.

## make-latency-table.mjs — why the latency table is generated, not written

`latency-table.txt` used to be assembled by hand from the three RTT runs, and its 0 ms column did
not match `out-rtt0.txt`: it showed Playwright at 76 ms where the run file says 64, Puppeteer at
72 where the file says 86, Selenium at 177 against 166, and the BiDi client at 54 against 52. The
20 ms and 60 ms columns were correct. Nobody could have reproduced that 0 ms column from anything
shipped here.

It is now derived from the three run files, so the figure and the evidence cannot drift apart:

```bash
node make-latency-table.mjs
```

One thing to know when reading the two figures together. The walk times in `fig-1` come from a
later `bench.mjs` run than the `RTT 0ms` column here, so they differ by a few milliseconds on the
same measurement. That is the run-to-run variance this README documents, not a contradiction, and
the ladder's own 0 ms column is the one to compare against its 20 ms and 60 ms neighbours.

## bidi-load-cost.mjs — the dash in the matrix

`bench.mjs` prints `-` for the BiDi row's load cost, because that arm was never instrumented for
it while every other row reports RSS added by importing its client. This measures it the same
way, in a fresh process per sample, since a second import is free:

```bash
node bidi-load-cost.mjs
```

```text
raw     14.0 MB   the ws package alone, a hand-rolled BiDi client
armed   26.3 MB   ws plus selenium-webdriver, which the arm uses to spawn
                  chromedriver and negotiate webSocketUrl before taking the socket over
```

The guide reports 26 MB, because that is what the benchmarked arm actually loads. It cannot be
folded back into `bench.mjs` honestly: that process imports `ws` at the top for the counting
proxy, so an in-harness reading would show only the selenium delta and undercount by about 14 MB.

## lp-vs-chrome.mjs — does Lightpanda build the same DOM?

Lightpanda's headline is 10 MB against Chromium's 430. The question that decides whether that is
usable is whether it renders the same page. This drives the same three sites through both
engines in one session, three repeats each, and compares node counts:

```bash
node lp-vs-chrome.mjs
```

```text
react.dev    chrome  1846 nodes   lightpanda  1847   ratio 1.00
angular.dev  chrome   485 nodes   lightpanda   485   ratio 1.00
vuejs.org    chrome   619 nodes   lightpanda   754   ratio 1.22
```

Two of three match Chrome node for node. vuejs.org does not, and Lightpanda returns more nodes
rather than fewer, so the divergence is a different DOM and not simply an unfinished one.

A single-sample version of this probe once read angular.dev at 385 against Chrome's 485 and
would have supported a false claim that Lightpanda under-renders it. Three repeats in one
session showed the 385 was noise. Anything that would print an unflattering number about a tool
gets repeated before it gets written down.

## tls-probe.mjs and ja3-stability.mjs — the layer below the browser

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

**Headless changes nothing here.** JA4 and the HTTP/2 fingerprint are byte-identical headless
and headful, so headless is a JavaScript-layer tell (the UA string, `navigator.webdriver`),
not a network-layer one. Effort spent on TLS to hide headless is spent in the wrong place.

**JA3 is noise for Chrome.** `ja3-stability.mjs` ran three repeats of each mode and returned
six distinct JA3 hashes from six runs, while JA4 held at one value per mode and matched across
modes. JA3 does not normalise the GREASE values Chrome randomises per connection. Anyone
comparing JA3 hashes to verify a stealth setup is reading randomness.

**Lightpanda's tell is below JavaScript.** Its JA4 and HTTP/2 fingerprints differ from
Chrome's, which no User-Agent override reaches. That sharpens the trade in the guide: it is
not only that it announces itself in the UA, it does not handshake like Chrome either.

## Environment the published numbers came from

Apple M3, eight cores, 16 GB RAM, macOS 26.6.2, Node v25.9.0, Google Chrome for Testing
153.0.8010.47 with matching chromedriver, playwright-core 1.63.0, puppeteer-core 25.11.0,
selenium-webdriver 4.49.0, cypress 16.1.0, and Lightpanda 1.0.0-nightly.

Raw output for all three latency settings is in `out-rtt0.txt`, `out-rtt20.txt`, and
`out-rtt60.txt`.

## Overrides

`CHROME_PATH` and `CHROMEDRIVER_PATH` point the harness at binaries you already have.
