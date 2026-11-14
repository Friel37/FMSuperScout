# FMSuperScout for FM27 (Windows preview)

This branch uses an external, read-only .NET reader and the existing local web viewer.
BepInEx, game-folder changes and the in-game F9 hotkey are not used.

Supported: Steam App ID 4530370, build 26577676, game_plugin.dll product version
27.0.1+2503222. Other builds are rejected until their memory layout is verified.

## Start

Download the Windows x64 ZIP from [Releases](https://github.com/Laurentiu-Andronache/FMSuperScout/releases), extract the whole folder, then open a launcher below. The release bundles Node.js and the .NET runtime; no SDK, BepInEx or separate runtime installation is required. The ZIP is portable and unsigned.

Open `Start FMSuperScout.cmd` (browser) or `Start FMSuperScout (app-venster).vbs`
(standalone window). Load a save in FM27, then click **New data** in the viewer.
The local address is http://localhost:8765. FM may stay open throughout.

## Rebuild / set up another checkout

Requires the .NET 10 SDK and Node.js. No JavaScript dependencies are needed.

```powershell
powershell -ExecutionPolicy Bypass -File tools/setup-local.ps1 -NodeExe C:\path\to\node.exe
.\dist\runtime\node.exe --test test/*.test.js
dotnet run --project test/ReaderTests.csproj
```

The setup script publishes a framework-dependent Windows x64 reader into `dist/reader`
and copies Node into `dist/runtime`. Running the reader requires the .NET 10 runtime.
The existing local installation has both the SDK and runtime.

Data, status, diagnostics and history live in `%LOCALAPPDATA%\FMSuperScout\FM27`.
Browser settings use a separate FM27 namespace. Old FM26 data is not migrated.
Automatic upstream updates are disabled because those releases install the FM26 plugin.
The `plugin/` and `installer/` directories retain historical FM26 code; their installation
and packaging scripts are not the FM27 setup workflow. The release is a portable ZIP, not an installer.

## Reader and accuracy

`dist/reader/FMSuperScout.Reader.exe probe` reports installation/process/build readiness.
`dump --data-dir <directory>` performs one export. The server launches it on demand.
It uses OpenProcess with query/read rights and ReadProcessMemory; it never writes game memory.
Native player, staff and club arrays replace the old whole-process heap scan.

Field-layout leads came from the local fm-editor FM27 layout documentation and were
checked against this Windows process. The reader is independent of that application.
See [FM27 validation](docs/fm27-validation.md) for tested coverage and limitations.

The viewer retains search, filters, comparisons, shortlist, staff, squad analysis and
history. **Export to FM27** writes the shortlist's players as an FM shortlist file into
`Documents\Sports Interactive\Football Manager 27\shortlists` (load it in FM via the
shortlist screen). This only writes that file; game memory is never touched. Value fallbacks, interest, potential projections and role/meta scores remain
estimates using the existing models; they have not been recalibrated for FM27.
The displayed game date is approximate (team schedule / derived season), not the world clock.

## Troubleshooting

- Reader missing: run the setup script above.
- Game not running: launch the supported FM27 Steam installation and load a save.
- Unsupported version: do not bypass the version gate; offsets need revalidation.
- Failed read: pause simulation, finish loading, then retry New data. The last good dump stays available.
- Details: inspect `reader.log`, `status.json` and `diagnostics.txt` in the FM27 data directory.
- Close the command window to stop the browser-mode server. The standalone window stops its server automatically.

## Build a portable release

Run `powershell -ExecutionPolicy Bypass -File tools/build-release.ps1 -NodeDir C:\path\to\official-node-distribution` from a committed checkout. This publishes a self-contained Windows reader, includes runtime notices and Node licensing, and writes the ZIP plus SHA256SUMS.txt under `dist/releases`. Game dumps, logs, settings and saves are excluded.
