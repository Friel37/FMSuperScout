# FM27 validation — 27.0.1+2503222, 2026-11-12

Target: Windows Steam 4530370 / build 26577676; native product 27.0.1+2503222.
The version gate is the only reader change. Array and vtable RVAs stay on the
full-release layout below. Live check: 215,676 player pointers (ordinary vtable
0x4E2B4E8 offset 0x288, player-coach 0x508FCB8 offset 0x380) and 81,211 staff
pointers (ordinary 0x4E90848 offset 0x100, player-coach 0x508FCA0, human manager
0x4DC48CC offset 0x440). Toni Micevski still reads CA 40 / PA 122, and the high-CA
sample includes Haaland 195/195, Saka 188/188 and Vinícius Júnior 180/190.

# FM27 validation — full release, 2026-11-10

Target: Windows Steam 4530370 / build 26385295; native product 27.0.1+2494687.
Person offsets are unchanged (player 0x288, player-coach 0x380, staff 0x100,
human manager 0x440). The pinned RVAs moved: players 0x5820810, staff 0x5820858,
clubs 0x58209C8; player-coach vtables 0x508FCB8 / 0x508FCA0; human manager 0x4DC48CC.

# FM27 validation — Minor Update 1, 2026-11-03

Target: Windows Steam 4530370 / build 26340721; native product 27.0.0+2493426
(released 2026-11-02). Reader source change: `fm27-build-26340721-reader.patch`.

Every pinned game_plugin.dll RVA moved by exactly +0x2000; object layouts are unchanged.
Arrays: players 0x57057D0, staff 0x5705818, clubs 0x5705988. Vtables: player-coach
(player array) 0x4F77A08, player-coach (staff array) 0x4F779F0, human manager 0x4CC286C.
Every vtable found in the arrays passed the reader's dynamic person-offset self-check.

Live export of a 2028 Newcastle save: 94,833 players and 71,695 staff in 28 seconds,
human manager resolved, game date cross-checked by 24 team schedules. Witnesses kept
their PA from the original validation (Haaland 195, Mbappe 197, Yamal 195), Mbappe's
wage stayed 576610 and Yamal's value is still the unknown sentinel. All 35 JavaScript
tests and 14 .NET fixture assertions passed.

# FM27 validation — 2026-10-30

Target: Windows Steam 4530370 / build 26227640; native product 27.0.0+2486695.
The executable itself reports Unity 6000.3.18f1-custom, not the game version.

## Live evidence

Loaded Huelva save: native arrays contained 19,861 player pointers, 9,563 staff
pointers and 17,709 club pointers. Default men-only export contained 19,860 players
and 8,934 staff. The 30 player-coach staff facets are skipped, the platform account
placeholder is excluded, and gender filtering excludes 599 entries across both arrays.
No player/staff UID overlap remained. Export took approximately three seconds.

Native array data/end RVAs: players 0x57037D0/0x57037D8,
staff 0x5703818/0x5703820, clubs 0x5703988/0x5703990.
Human manager person offset changed from 0x450 to 0x440; this resolves Huelva.
Player-coach person offset 0x380; ordinary player 0x288; ordinary staff 0x100.

Independent read-only probes before implementation decoded:

| Player | CA / PA | Club | Wage GBP/week |
|---|---|---|---|
| Erling Haaland | 187 / 195 | Manchester City | 472500 |
| Kylian Mbappe | 192 / 197 | R. Madrid | 576610 |
| Lamine Yamal | 180 / 195 | Barcelona | 343612 |

The native value sentinel 300000000 (Yamal) remains unknown, triggering the viewer's
existing estimated value. Staff Youth is raw 1–20, unlike scaled coaching attributes.
Names, clubs, CA/PA and wages were checked in live exports. Full independent in-game
verification of every hidden attribute, transfer flag and women's record is not claimed.

## Checks

JavaScript model/i18n and reader-process lifecycle tests; .NET fixture checks for
invalid pointers, raw/scaled attributes, flagged dates, missing strings and monetary
sentinels. Repeat live export and HTTP readiness/refresh/status/dump checks.

## Limits

The game date remains an approximation; history is therefore approximate too.
The array identity check detects save unload/replacement but is not an atomic snapshot
of every changing field. Read while simulation is paused for best consistency.
Additional game builds require new evidence before the exact build gate is changed.

Final checks: 35 JavaScript tests and 14 .NET fixture assertions passed. HTTP refresh returned 202, an overlapping request returned 409, and the disabled updater returned 410. Desktop Chrome displayed the player list, Huelva search/My club results (40 including reserves/loans), and Jose Carlos’s attribute profile. Repeat exports retained the same counts and the three witness values above.
