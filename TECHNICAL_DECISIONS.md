# Technical Decisions

## Base project

Candidates on GitHub (Sept 2026):

| Repo                                            | Notes                                                                                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **mermaid-js/mermaid-live-editor** (6.8k★, MIT) | Official editor; Monaco, live preview, pan/zoom, PNG/SVG export, every diagram type, History, actively maintained. Web-only, no file I/O. |
| Vesperino/MerMarkEditor (243★, MIT)             | Tauri Markdown editor with Mermaid support. Markdown-first; needs a Rust toolchain (not installed).                                       |
| pedsm/iemanja (17★, no license)                 | Small Electron editor, unmaintained since 2023, no license.                                                                               |

**Chosen: the official Mermaid Live Editor**, forked to `drcurtisiii/mermaid-live-editor`
(remote `upstream` kept for merges). It is the best Mermaid editor available and keeping the web
app nearly untouched (≈20 changed lines) makes upstream updates cheap.

## Desktop stack

| Option             | Verdict                                                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Electron**       | Chosen. The editor is a SvelteKit SPA using Monaco + Web Workers; Electron's bundled Chromium runs it exactly as tested upstream, on Windows 10 and 11, with mature portable packaging (electron-builder) and icon/version embedding. |
| Tauri              | Smaller binary, but WebView2 differences to test, and needs a Rust toolchain on every build machine.                                                                                                                                  |
| .NET + WebView2    | Good native integration, but the .NET SDK is not installed here, and it adds a second language for little gain.                                                                                                                       |
| Python (pywebview) | Adds a runtime and PyInstaller/AV issues for no benefit; the app is already JS.                                                                                                                                                       |

## Single-file release: custom launcher (since 1.2.0)

Versions 1.0.0 and 1.1.0 used electron-builder's "portable" target. Measured on this machine it
re-unpacked ~390 MB to `%TEMP%` on **every** launch: about 34 s to a window, against 0.9 s for
the app itself. Since 1.2.0 the release exe is `launcher/Launcher.cs`, a small .NET Framework
program with the packaged app embedded as a zip resource:

- it unpacks once per version to `%LOCALAPPDATA%\MermaidViewEdit\app\<version>-<payload id>\`
  (temp folder, then rename, with a `.complete` marker written last), then starts the app;
- later launches take about 0.6 s, and the launcher exits at once, so the release exe is not
  locked while the app runs;
- it sets `PORTABLE_EXECUTABLE_FILE` / `PORTABLE_EXECUTABLE_DIR`, so updates and shortcuts still
  refer to the release exe;
- it removes unpacked copies of other versions that are not running.

It is compiled with the C# 5 compiler that ships with Windows, so no SDK is needed. Trade-off:
the exe is about 165 MB (zip compresses less than the old format).

## Architecture

- `src/` — upstream web app. Desktop additions: `src/lib/util/desktop.ts`,
  `src/lib/components/DesktopBridge.svelte`; small edits to the edit page, layout (no service
  worker in desktop) and navbar label.
- `desktop/main.cjs` — Electron main: `mve://app/` protocol serving the static build with path
  traversal guard, windows, menus, file open/save, file watching, updates.
- `desktop/preload.cjs` — three-function bridge (`ready`, `codeChanged`, `onLoadDocument`);
  renderer is sandboxed, context-isolated, no Node.
- `desktop/lib/*.cjs` — pure Node modules (documents, updater, settings/log), unit-tested with
  `node --test`.
- One file-opening function (`openPaths`) serves double-click, shortcut drops, second-instance
  forwarding and File > Open.

## Versioning

Single source of truth: `desktop/package.json` `version`. Electron exposes it as
`app.getVersion()` (`APP_VERSION` in `main.cjs`); electron-builder stamps it into the exe
resources and filename.

## Single instance and update hand-off

`requestSingleInstanceLock` forwards later launches' files to the running app (two Electron
processes cannot share the browser profile's storage). After an update the new exe is started
with `--mve-wait-pid=<old pid>` and waits (≤ 20 s) for the old process to exit before starting.

## Build environment

- Node 24 + corepack pnpm 10 (web, locked by `pnpm-lock.yaml`), npm (desktop, `package-lock.json`).
- `node_modules`, `docs`, `.svelte-kit`, `desktop\dist`, `desktop\web` are marked
  `com.dropbox.ignored` so Dropbox does not sync build folders.
- Code signing: not configured (`CSC_IDENTITY_AUTO_DISCOVERY=false`).
