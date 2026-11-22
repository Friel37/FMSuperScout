# FM27 build coupling — reader pins, gate and re-validation

The reader does not "read FM27" in general: it reads one **exact game build**. Every pinned
address is a relative virtual address (RVA) inside `game_plugin.dll`, and a game patch moves them.
This document records what is pinned in 1.5.0-fm27.2, how the code enforces it, and what a future
build needs. Companion file: [architecture.md](architecture.md).

Evidence lives in `docs/fm27-validation.md` (dated ledger) and
`docs/fm27-build-26340721-reader.patch` (one historical source diff). The reader source itself
(`reader/*.cs`) is **not** in this ZIP, so nothing here can be re-derived by rebuilding — only by
the shipped binary's behaviour and the recorded ledger.

---

## 1. The gate: three values, checked twice

The reader locates FM through Steam (App ID **4530370**), reads `installdir` from the app
manifest, then compares two values before it touches memory:

| Check | Current value |
|---|---|
| `appmanifest_4530370.acf` → `buildid` | **26620374** (`Fields.SUPPORTED_STEAM_BUILD`) |
| `fm_Data\Plugins\x86_64\game_plugin.dll` → `ProductVersion` | **27.1.0+2505117** (`Fields.SUPPORTED_VERSION`) |
| Reader version | `1.5.0-fm27.2` (`ReaderHost.Version`, also written to `meta.readerVersion`) |

`probe` returns the comparison result as `supported`, together with `productVersion` and
`steamBuildId`, so the viewer can show *what* was found without guessing. `dump` re-runs the same
probe and throws `Unsupported FM build. Expected Steam <build> / <version>.` — the message is built
from the same constants as the check, so it cannot drift from the gate.

The gate is enforced in two layers:

1. **Reader** — refuses to scan, exits non-zero, leaves `status.json` in `error` and an existing
   `dump.json` untouched.
2. **Viewer** — `meta.gameVersion` / `meta.supportedVersion` / `meta.versionOk` drive a warning
   banner (`renderVerWarn()`), so a dump from a different build is *loaded but flagged* rather than
   silently trusted. Dumps without `readerVersion` (older exports) get a "fetch fresh data" banner.

---

## 2. Offsets currently in effect

Newest ledger entry (`fm27-validation.md`, 27.1.0+2505117):

| Item | RVA / offset |
|---|---|
| Player pointer array | `0x587B8B8` |
| Staff pointer array | `0x587B900` |
| Club pointer array | `0x587BA70` |
| Player-coach vtable (player array, person at `+0x380`) | `0x50EAC28` |
| Player-coach vtable (staff array — skipped, already in player array) | `0x50EAC10` |
| Human manager vtable (person at `+0x440`) | `0x4E2170C` |
| Ordinary player person offset | `0x288` |
| Ordinary staff person offset | `0x100` |
| UID field | `OBJ_DUNI = 0x0C` |

Movement from the 27.0.1 pins was **+0x5B0A8** for all three arrays; person offsets did not change.
Every record still passes the dynamic person-offset self-check
(`DynamicOffsetFromVtable(vtable at person[0]) == expected offset`), which is what makes a moved
layout fail loudly instead of producing plausible-looking garbage.

---

## 3. Build history (as recorded)

| Date | Steam build | `game_plugin.dll` product | Arrays | Vtable family |
|---|---|---|---|---|
| 2026-10-30 | 26227640 | 27.0.0+2486695 | `0x57037D0` / `…818` / `…988` | `0x4F759F0` / `0x4F75A08` / `0x4CC086C`; manager person `0x440` (was `0x450`) |
| 2026-11-03 (Minor Update 1) | 26340721 | 27.0.0+2493426 | `0x57057D0` / `…818` / `…988` (+0x2000) | `0x4F779F0` / `0x4F77A08` / `0x4CC286C` |
| 2026-11-10 (full release) | 26385295 | 27.0.1+2494687 | `0x5820810` / `…858` / `…9C8` | `0x508FCA0` / `0x508FCB8` / `0x4DC48CC` |
| 2026-11-12 | 26577676 | 27.0.1+2503222 | unchanged | unchanged — **gate-only change** |
| 2026-11-22 (current) | 26620374 | 27.1.0+2505117 | `0x587B8B8` / `…900` / `…A70` | `0x50EAC10` / `0x50EAC28` / `0x4E2170C` |

Pattern: patches move the arrays and vtables; the person offsets (`0x288`, `0x380`, `0x100`,
`0x440`) have been stable since 2026-10-30. One patch (27.0.1+2503222) changed only the build
string, which is why the gate compares a pair (build ID *and* product version).

---

## 4. Integrity guards beyond the gate

- **Per-record layout check** — every candidate must decode to the expected person offset, else the
  export aborts with `Unexpected person layout: … Existing data was kept.`
- **Array identity check** — after the scan both arrays are re-read and compared; a difference
  throws `Save changed during reading. Retry with the game paused.` (detects save unload or
  replacement; it is not an atomic snapshot, hence the advice to pause the simulation).
- **Single reader instance** — a named mutex; a second `dump` prints `A read is already running.`
  and exits with code 3, which the viewer surfaces as HTTP 409.
- **Read-only access** — `OpenProcess` + `ReadProcessMemory` only; the game is never written and no
  plugin or assembly is injected. That is also why the shortlist path writes `.fmf` files instead of
  calling into the game.
- **Sentinel handling** — `300000000` (unknown value) and `0xFFFF` reputation are filtered in the
  viewer, so a shifted field shows up as missing values rather than as fabricated numbers.

---

## 5. The 26340721 patch vs the shipped reader

`docs/fm27-build-26340721-reader.patch` is the diff applied for the **2026-11-03** milestone. It is
*not* a description of the shipped binary:

| Item | In the patch (26340721) | Shipped 1.5.0-fm27.2 |
|---|---|---|
| Arrays | `0x57057D0` / `0x5705818` / `0x5705988` | `0x587B8B8` / `0x587B900` / `0x587BA70` |
| Player-coach vtables | `0x4F77A08` (player), `0x4F779F0` (staff) | `0x50EAC28`, `0x50EAC10` |
| Human manager vtable | `0x4CC286C` | `0x4E2170C` |
| `SUPPORTED_VERSION` | `27.0.0+2493426` | `27.1.0+2505117` |
| `steamBuildId` | `26340721` | `26620374` |
| `ReaderHost.Version` | bumped `1.5.0-fm27.1` → `1.5.0-fm27.2` | `1.5.0-fm27.2` (same string, later offsets) |

What the patch *does* document about the design:

- It introduced `Fields.SUPPORTED_STEAM_BUILD` and replaced the hardcoded `"26227640"` in both the
  probe (`Get("buildid") == "26227640"`) and `meta.steamBuildId`, so build ID and product version now
  come from one constant pair.
- It made the unsupported-build error message derive from those constants.
- It added the post-scan array identity check (`SequenceEqual(mem.ArrayAt(...))`).
- It shows exactly what a milestone touches: the three `ArrayAt()` calls plus the two arrays in the
  identity check, the three vtable literals, the two gate constants and the reader version string.

**Consequence:** the reader version string is *not* a build discriminator — the 26340721 diff and
the shipped 26620374 binary both call themselves `1.5.0-fm27.2`. Use the newest ledger entry for
locations and `probe`/`meta` for what a given binary actually supports. Never transplant RVAs from
this patch into a current build.

---

## 6. Adding a new game build

1. Record the new `buildid` and `game_plugin.dll` `ProductVersion`; confirm App ID `4530370`.
2. Locate the three pointer arrays and the three vtables in the new binary with the same data/end
   pair method used before; verify counts against a live save.
3. Update the gate constants (`SUPPORTED_VERSION`, `SUPPORTED_STEAM_BUILD`) and every `ArrayAt()` /
   vtable literal — three in the scan, two arrays in the identity check, three vtable comparisons.
4. Confirm the person offsets (`0x288`, `0x380`, `0x100`, `0x440`) still pass the dynamic
   self-check; a mismatch means the object layout changed and the field map, not just the gate,
   needs work.
5. Re-run the witnesses: Haaland 195 PA, Mbappe 197 PA with wage 576610, Yamal 195 PA with the
   `300000000` value sentinel. Take a fresh live export and record counts and timing.
6. Add a dated section to `docs/fm27-validation.md` stating what moved and what was verified, and
   repeat the "Limits" caveats (in-game date stays approximate, history inherits it, no atomic
   snapshot).
7. Keep the previous reader: rename `dist\reader` to `dist\reader-fm<version>-backup\` and place
   the new build beside it, as this folder does.
8. Rebuild the portable ZIP, run `npm test` and the .NET fixture checks from a source checkout (not
   shipped in the ZIP), and exercise the HTTP readiness / refresh / status / dump / 409 / 410 paths.

The standing ledger rule: **additional game builds require new evidence before the exact build gate
is changed.** Widening the gate to gain compatibility silently produces wrong attributes, which is
worse than a clear "unsupported build" error.

---

## 7. What is not verified by this coupling

- The in-game date is an estimate (`gameDateSource: "estimated"`); growth, intake and contract
  maths inherit that approximation.
- Attribute-level correctness is spot-checked, not proven: the ledger explicitly does not claim
  independent in-game verification of every hidden attribute, transfer flag or women's record.
- Fee, interest and role-score models are FM26-calibrated and were not re-fitted for FM27.
- The array identity check detects a reloaded or swapped save, not a field changing mid-scan.

