# FMSuperScout 1.5.0-fm27.2 — architecture and data flow

Scope: the shipped portable Windows x64 ZIP (FM27 branch). Derived from a full read of
`app/*.js`, `app/index.html`, `docs/*`, and from the live runtime directory
`%LOCALAPPDATA%\FMSuperScout\FM27` (dump 274.9 MB, 181,682 players / 64,745 staff, scan of
2026-11-22 08:50). `tools/` and `test/` are **not** part of this ZIP; the README references
them for a source checkout only.

Read [fm27-build-coupling.md](fm27-build-coupling.md) together with this file: the reader is
pinned to one exact game build and each game patch needs new evidence.

---

## 1. Components

| Path | Role |
|---|---|
| `Start FMSuperScout.cmd` | Browser mode: opens `http://localhost:8765`, then runs `dist\runtime\node.exe app\server.js`. |
| `Start FMSuperScout (app-venster).vbs` | Sets `FMSS_APP=1`, starts the server hidden; the server opens a chromeless Edge `--app` window and exits when that window closes. |
| `dist\runtime\node.exe` | Bundled Node (v24.22.2). No npm dependencies are required. |
| `app\server.js` | Local HTTP server: static files, JSON API, history store, shortlist export, self-update plumbing, window lifecycle. |
| `app\reader-process.js` | Spawns and supervises `dist\reader\FMSuperScout.Reader.exe`; owns `status.json` placeholders and `reader.log`. |
| `dist\reader\` | Self-contained .NET 10 x64 reader (`FMSuperScout.Reader.exe`/`.dll`, coreclr, host, BCL). CLI: `probe`, `dump --data-dir <dir>`. |
| `dist\reader-fm27.1-backup\` | Previous reader DLL (62,464 → 61,952 bytes), kept for rollback. |
| `app\app.js` | Entire viewer: i18n (nl/en/fr/de), streaming dump parser, virtualised table, filters, profiles, best XI, transfer report, squad analysis, clubs view, history/growth, shortlist, player cards, bug report. |
| `app\index.html`, `style.css` | Shell and styling. |
| `app\fmf.js` | Reads an existing FM shortlist `.fmf` as byte template and builds a new one. |
| `app\nations.js` | Nation table keyed by FM's stable nation ID: `[nl, en, fr, de, eu]`. |
| `docs\fm27-validation.md` | Build-validation ledger: gate, pinned RVAs, witness players, live counts. |
| `docs\fm27-build-26340721-reader.patch` | Historical source diff for the 26340721 milestone (not the shipped binary revision). |

No frameworks, no bundler, no transpiler: plain ES2020 in the browser, CommonJS in Node, C# in the reader.

---

## 2. Process lifecycle

- Port `8765` (`PORT` env overrides), bound to `127.0.0.1` only.
- Data directory is `%LOCALAPPDATA%\FMSuperScout\FM27` — taken from `LOCALAPPDATA` explicitly, not
  from `os.homedir()`, so a redirected profile resolves to the same folder the reader writes.
- `APP_MODE` (`FMSS_APP=1`): a watchdog exits the server when no request arrived for 90 s;
  `POST /api/bye` (pagehide beacon) schedules exit after 2.5 s unless a heartbeat cancels it.
  The viewer heartbeats every 4 s and again on focus/visibility change.
- Every request must carry a `localhost` / `127.0.0.1` `Host` header, and any `Origin` must be
  local, else 403 (DNS-rebinding and cross-site protection).
- `EADDRINUSE` → the already-running instance's window is re-opened and the new process exits.
  `uncaughtException` is logged; the server keeps running.

```
launcher ──> node app\server.js (127.0.0.1:8765)
                │
       ┌────────┴─────────┐
  static + JSON API   filesystem: %LOCALAPPDATA%\FMSuperScout\FM27
  (browser/Edge)        dump.json  status.json  reader.log  diagnostics.txt
                        scan-config.json  history\<manager>.json
                              ▲                │ spawn
                              │                ▼
                     reader writes      FMSuperScout.Reader.exe
                                       probe | dump --data-dir <dir>
                                                │ OpenProcess + ReadProcessMemory (read-only)
                                                ▼
                                            fm.exe (Steam 4530370)
```

---

## 3. HTTP API

All routes are served from `app/server.js`; `reader` below means `reader-process.js`.
Viewer call sites are in `app/app.js`.

| Route | Method | Behaviour | Viewer consumer |
|---|---|---|---|
| `/api/status` | GET | Newest `dump*.json` by mtime (name, time, size from the same stat) + parsed `status.json` + its mtime. Returns `dataDir, hasDump, dumpFile, dumpTime, dumpSize, appMode, reader, plugin` (`plugin` is a compatibility alias of `reader`). | `poll()`, `loadDump()`, fetch timeout, `initHeartbeat()` |
| `/api/scan-config` | GET/POST | `{db: "men"|"women"|"both"}` in `scan-config.json`. Legacy `includeWomen:true` is read as `both`. The reader reads this file on every scan. | Settings → Database |
| `/api/diagnostics` | GET | Raw `diagnostics.txt` (404 when absent). | `reportBug()` (first 12 lines, up to first blank line) |
| `/api/heartbeat` | ANY | 204; resets the app-mode watchdog and cancels a pending exit. | every 4 s in app mode |
| `/api/bye` | POST | 204; schedules exit in 2.5 s (reload sends a heartbeat). | `pagehide` beacon |
| `/api/fmstatus` | GET | Direct `probe` result, wrapped with `known` / `readerInstalled`. | "New data" gate |
| `/api/setup` | GET | Same probe via `checkSetup` (legacy name from the BepInEx era). | `checkSetupState()` |
| `/api/refresh` | POST | Starts one export. 202 accepted, 409 already running, 503 + error status when the exe is missing, 500 on spawn failure. | "New data" |
| `/api/dump` | GET | Streams the newest dump with `Content-Length` and `no-store`; read errors destroy the response instead of killing the process. | `loadDump()` |
| `/api/history` | POST | Delta-only merge into `history\<manager-slug>.json`; body limit 64 MB. | `postHistorySnapshot()` |
| `/api/history/deltas` | GET | `?manager=` alone → `{dates, ref:null, p:{}}` (small probe). With `?since=` → per uid `[ca, pa, firstSeenIndex]`. | `loadHistDeltas()`, `refreshHistDeltas()` |
| `/api/history/series` | GET | `?manager=&uid=` → `{dates, attrKeys, entries}` for one player. | development chart |
| `/api/shortlist-fmf` | POST | Writes `<name>.fmf` into the FM27 shortlist folder (resolved from the shell-folder registry key, `FMSS_SHORTLIST_DIR` overrides). Name sanitised, ids deduped and range-checked, 409 unless `overwrite`. | "Export to FM27" |
| `/api/version-check`, `/api/update-install`, `/api/update-status` | ANY | **410 before any handler**: automatic updates are disabled because upstream releases install the FM26 plugin. | `checkUpdate()` is also stubbed to `return null` |
| everything else | GET | Static files from `app\`, path-normalised, `..` stripped, `no-store`. | page load |

---

## 4. Reader contract

### CLI

```
FMSuperScout.Reader.exe probe
FMSuperScout.Reader.exe dump --data-dir "%LOCALAPPDATA%\FMSuperScout\FM27"
```

Observed `probe` output (FM closed at the time of writing):

```json
{"installed":true,"running":false,"supported":true,"processId":0,
 "gameDir":"c:\\program files (x86)\\steam\\steamapps\\common\\Football Manager 27",
 "productVersion":"27.1.0+2505117","steamBuildId":"26620374"}
```

`dump` exits non-zero on any failure and prints the reason to stdout/stderr, which the server
redirects into `reader.log`.

### Server-side supervision (`app/reader-process.js`)

- `probe`: `execFile(..., ['probe'], {timeout: 10000})`. Missing exe → `readerInstalled: false`
  plus "Reader missing. Run tools/setup-local.ps1." Unparsable output → `running: false` plus the
  error message.
- `refresh`: rejects with 409 while a child is alive; writes the `scanning` placeholder itself
  (atomically via `.server.tmp` → rename), truncates `reader.log`, spawns the child with
  stdout+stderr on that log. If the child exits non-zero and the reader did not already write
  `state: "error"`, the wrapper replaces the status with "Reader stopped before completing.
  Load your save and retry."

### `status.json`

`{"state":"scanning"|"done"|"error","players":n,"staff":n,"at":"<iso>","progress":0..1,"error":"…"}`

Live example: `{"state":"done","players":181682,"staff":64745,"at":"2026-11-22T08:50:20"}`.
`progress` and `error` are optional; the viewer tolerates older shapes.

### Telemetry

`reader.log` records the read source, available memory, scan regions, the `game_plugin.dll`
product version against the pinned offsets, vtable candidate counts, squad-walk passes, resolved
manager/club, derived season year, in-game date plus cross-check votes, player/staff dedupe and
total timing. `diagnostics.txt` adds the class-offset histogram and phase timings.

Last run: 301,526 vtable candidates, 181,682 players / 64,745 staff, native array walk 93.9 s,
two squad walks 4.4 s each, JSON write 1.7 s, total 104.8 s, 274.9 MB written.

---

## 5. `dump.json` schema

Shape as observed on disk (values trimmed for readability):

```jsonc
{
  "meta": {
    "generated": "2026-11-22T08:50:18",
    "gameDate": "2030-03-02", "gameDateSource": "estimated", "gameYear": 2030,
    "readerVersion": "1.5.0-fm27.2",
    "steamBuildId": "26620374",
    "gameVersion": "27.1.0+2505117", "supportedVersion": "27.1.0+2505117", "versionOk": true,
    "manager": "Ryan Friel", "myClub": "Newcastle United", "myClubRep": 7233,
    "currency": "GBP",
    "source": "FMSuperScout external reader v1.5.0-fm27.2"
  },
  "players": [
    {
      "id": 12315, "name": "Toni Micevski", "age": 24, "dob": "2005",
      "birthYear": 2005, "birthDoy": 313,
      "nat": ["North Macedonia"], "natId": 781,
      "club": "FK Poeševo", "div": "North Macedonian Fourth League",
      "ca": 40, "pa": 122, "wage": 0, "expires": null,
      "pos": "ST", "posArr": ["ST"], "teamType": 0,
      "foot": "Rechts", "height": 188,
      "value": 0, "askingPrice": 0, "wageDemand": null,
      "listed": false, "loanListed": false, "notForSale": false, "setForRelease": false,
      "clubRep": 300, "worldRep": 927,
      "ambition": 5, "loyalty": 2, "professionalism": 8, "adaptability": 15,
      "pressure": 8, "sportsmanship": 8, "temperament": 12, "controversy": 6,
      "attrs": { "Crossing": 12, "Dribbling": 9, "...": "49 keys, Latin names" }
    }
  ],
  "staff": [
    {
      "id": 1, "name": "…", "age": 47, "dob": "1979",
      "birthYear": 1979, "birthDoy": 100,
      "nat": ["England"], "natId": 797,
      "club": null, "div": null, "ca": 91, "pa": 183,
      "wage": null, "expires": null, "job": "Staflid",
      "staffAttrs": { "Aanvallen": 12, "...": "20 keys, Dutch names" }
    }
  ]
}
```

Schema asymmetries that cost time if forgotten:

- Player attribute keys are Latin (FM UI names), staff attribute keys are Dutch — separate
  lookup tables in `app.js`.
- `foot` is Dutch (`Rechts` / `Links` / `Beide`) because it is read from a game string; the
  viewer maps it for display.
- `job` is the internal value `Staflid` for most staff; the viewer translates it by `jobId`.
- Sentinels: `worldRep: 65535` (`0xFFFF`) means "no reputation set" and is treated as a ghost
  record for newgens without a club; `value: 300000000` means "unknown value".
- `gameDateSource` is `memory` when the date came from one authoritative field and `estimated`
  when it was derived from fixtures/season data (shown with a leading `~` in the header).
- Players carry the visible personality attributes; staff records do not.

---

## 6. Viewer pipeline

1. **Start a scan** — `#btn-fetch` → `GET /api/fmstatus`. Aborts with "Start FM and load your
   save first" when `running` is false, or shows `st.error` when the exe is missing. Then
   `POST /api/refresh`; any non-2xx body is displayed verbatim.
2. **Watch it** — `poll()` runs every 2 s (750 ms while scanning):
   - `scanning` → progress bar from `reader.progress`; if the status file's mtime is older than
     15 s the scan is declared stalled (FM closed or crashed).
   - `error` → red banner with `reader.error`.
   - `done` → "new dump" when `dumpTime` changed, or a `scanning` state was seen, or a pending
     click now sees a different `dumpTime`.
   A 15 s "request not picked up" timer is armed at click time and cancelled by either signal;
   it points the user at the troubleshooting section.
3. **Load** — `loadDump()`:
   - `GET /api/status`; without a dump the empty state (3 steps) is shown.
   - `localStorage.fmss27_loadmark` still set from a previous attempt means that load killed the
     tab (OOM) → dedicated crash message with an explicit retry instead of a reload loop.
   - `GET /api/dump` with an `AbortController` (a newer click aborts the load in flight).
   - `parseDumpStream()` scans the byte stream incrementally: metadata first, then one `players`
     element and one `staff` element at a time, yielding to the UI every 8 MB. The dump counts as
     complete only when the top-level brace depth is back to 0, no string is open and at least one
     record was read; otherwise the fallback `resp.json()` is tried.
   - Ghost newgens are dropped (`club` set or `worldRep !== 0xFFFF`).
   - State is committed, caches invalidated, `refYear`/`refDoy` derived from `meta.gameDate` (or
     `meta.gameYear`), `dumpStamp` recorded, then header, club badge, version banner, chips,
     filters and divisions are rendered and the table filtered.
   - After 100 ms the snapshot is uploaded, deltas are fetched and the growth column, filters and
     intake banner are refreshed, so "new since" includes the snapshot just written.
4. **History** — `postHistorySnapshot()` streams `{manager, gameDate, attrKeys, players:{uid:[ca,
   pa, value, attrs…]}}` with attribute values in `attrKeys` order. Skipped when `fmss27_hist_at`
   equals the current `dumpStamp`.
5. **Growth** — `histRefDate()` resolves `last | m6 | y1 | season | all` against the delta dates;
   `caGrowth` is suppressed below CA 40 (noise); the first-seen index drives the "new" marker; the
   intake banner triggers when the database grew by ≥ 200 players, more than 70 % of the additions
   are 17 or younger, and that cohort is under 40 % of the database.

### Table click-filters

The club, nationality and position cells of the player/staff list render as `span.cellfilter`
(`clubCell` / `natCell` / `posCell`); each carries `data-club`, `data-nat` or `data-pos`. The row
handler in `renderVisible` routes such a click to `filterByClub` / `filterByNat` / `filterByPos`
instead of opening the profile. Club filtering uses an exact `state.clubFilter` match — the search
box stays a substring match over name *and* club — while nationality reuses the existing `f-nat`
field and position reuses the pitch selection (`activePos`, mirrored back onto the pitch nodes —
the pitch section's *All positions* / *No positions* buttons fill and empty that same set).
A composite value (`"DM, MC"`) yields one span per code, so a click filters on exactly the clicked
one. Clicking the same value again clears the filter; each click also resets the table scroll,
because the row that was clicked can fall outside the much shorter result list.

---

## 7. Values the viewer derives (not stored in the dump)

`estValue` / `estValueCalc` (sentinel-aware), `feeEstimate` / `feeMultiplier`, `wageRankInClub`,
`myWageCeiling`, `interestEstimate` (reputation gap, wages, personality, age, availability,
FIFA art. 19 minors), `statusHtml` (free / listed / loan / release / not-for-sale),
`isAttainable`, `roleScore` / `rolesForPos` / `bestRoles`, `metaScore` / `metaPaScore` /
`metaAtRole` (positional FM27 weighting, multi-position players weighted by impact),
`projectAttrs` / `physGrowthFactor` (physical growth stops at 23), `getAge` (birth year and
day-of-year against `refYear`/`refDoy`), `monthsUntil` / `expiresHtml`, `loanStatus`,
`clubLabel`, `isEu` (nation ID first, multi-language name fallback).

The README states these models were **not recalibrated for FM27**; they are FM26-era heuristics
applied to FM27 data. Treat fees, interest and role scores as indicative.

---

## 8. Persistence

| Location | Content |
|---|---|
| `dump.json` | Full export, 274.9 MB in the observed save. |
| `status.json` | Scan state machine (see §4). |
| `reader.log`, `diagnostics.txt` | Telemetry for support. |
| `scan-config.json` | `{db}`; read by the reader on every scan. |
| `history\<manager-slug>.json` | Delta-only history: `{manager, dates[], attrKeys[], players{uid:{date:[ca,pa,value,flatAttrs?]}}}`. 113.7 MB with dates from 2028-05-31 to 2030-03-02. |
| browser localStorage | `fmss27_loadmark`, `fmss27_hist_at`, `fmss27_histperiod`, `fmss27_loads`, `fmss27_intake_seen`, `fmss27_cur`, `fmss27_lang`, `fmss27_wageper`, `fmss27_hidemeta`, `fmss27_hidecapa`, `fmss27_profmode`, `fmss27_fmf_name`, column/preset/shortlist state, `fmss27_updchk`, `fmss27_upd_dismiss`. |
| FM shortlists folder | `<name>.fmf` built from a byte template (`fmf.js`); the game is never modified in memory. |

History rules (server side): a row is written only when CA/PA changed, the value moved by more
than max(10 000, 2.5 %), or any attribute changed; attribute diffs are stored as a flat
`[keyIndex, value, …]` list and folded forward on read; a game date at or before the last stored
date truncates the "future" (save reload or rewind); history is capped at 120 dates and older
dates are collapsed into a new baseline; writes are atomic (`.tmp` → rename).

---

## 9. Failure paths

| Symptom | Signal | User-facing result |
|---|---|---|
| No dump yet | `hasDump: false` | Empty state with the 3-step instructions |
| Reader exe missing | `readerInstalled: false`, refresh 503 | Banner "Reader missing…" |
| FM not running | `probe.running: false` | "Start FM and load your save first" |
| Unsupported game build | reader refuses to write, status `error` | Reader's message in the red banner |
| Request never picked up | 15 s timer, no `scanning`, unchanged `dumpTime` | "Not picked up" + troubleshooting link |
| FM crashed mid-scan | `scanning` with status file older than 15 s | "Scan stalled" |
| Half-written dump | stream parser `_complete === false` / no `meta.generated` | "Dump incomplete" |
| Parse failure on a readable dump | exception with `hasDump` true | Error state: size, detail, Retry / New data / Report |
| Tab killed by memory | `fmss27_loadmark` left set | Crash message: close FM, retry manually |
| Server gone | fetch rejects | "Server gone" with restart hint |
| Anything else | `/api/status`, `/api/diagnostics`, `reader.log` | Prefilled GitHub issue with environment and telemetry head |

---

## 10. Known divergences in this build

1. **`/api/setup` is vestigial.** The first-run box needs `setupState.pluginInstalled &&
   !setupState.interopReady`, but the external reader's `probe` never returns those fields
   (`installed` / `running` / `supported` / `processId` / `gameDir` / `productVersion` /
   `steamBuildId` only). The BepInEx-era setup box can therefore not appear.
2. **FM26-era copy still used in user-facing text**: "Run tools/setup-local.ps1" (there is no
   `tools\` in the ZIP), `reportBug()` citing `%LOCALAPPDATA%\FMSuperScout\` (the real path has
   `\FM27`) and `BepInEx\LogOutput.log`, and the `verWarn` fallback `supportedVersion` value
   `27.0.1+2503222`.
3. **Size profile**: 275 MB dump, 181k players × 49 attributes, 114 MB history file; the OOM
   marker path exists because a large save can kill the tab. History is bounded by date count
   (120), not by bytes.
4. **`worldRep === 0xFFFF` filter** also hides genuine free agents whose reputation field is unset
   — intentional, but a silent loss for free-agent scouting.
5. **In-game date is estimated** in the observed dump (`gameDateSource: "estimated"`), so growth,
   intake and contract maths inherit that approximation.
6. **Automatic updates are intentionally disabled**: the server answers 410 on the update routes
   and `checkUpdate()` returns `null`. Update by replacing the folder.
7. Fee, interest and role models are FM26-calibrated; see §7.

