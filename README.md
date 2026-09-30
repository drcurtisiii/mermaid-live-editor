# Mermaid View Edit

A Windows desktop app for viewing and editing [Mermaid](https://mermaid.js.org) diagrams with a
live preview. It is the official open-source **Mermaid Live Editor** (forked from
[mermaid-js/mermaid-live-editor](https://github.com/mermaid-js/mermaid-live-editor), MIT) in a
portable Windows executable that opens and saves real files. The upstream README is kept in
[README.upstream.md](README.upstream.md).

## What it does

- Drag `.mmd`, `.mermaid`, `.md` or `.txt` files onto the desktop shortcut. Each file opens in its
  own window with the code on the left and the rendered diagram on the right.
- Edit with syntax highlighting, autocomplete and error markers. The preview updates as you type.
- **Ctrl+S** saves back to the same file. The title bar shows `*` while there are unsaved changes.
- In Markdown files, the ` ```mermaid ` block is edited in place and the rest of the file is
  left as it was. If a file has several blocks, you pick which one to edit.
- If the file changes on disk (Claude, Dropbox, another editor), the window reloads it
  automatically. If you have unsaved edits, it asks first.
- Export PNG/SVG from the **Actions** panel, or use **File > Export SVG**. Pan/zoom, the hand-drawn
  style, themes, sample diagrams and the History timeline all work as they do upstream.

## System requirements

Windows 10 or 11, 64-bit. No installation, administrator rights or internet connection needed.

## First use and launch

- Double-click the **Mermaid View Edit v1.0.0** desktop shortcut, or
  `installer\Mermaid View Edit v1.0.0.exe`.
- The first launch of each version shows a short "Setting up" window while it unpacks the app to
  `%LOCALAPPDATA%\MermaidViewEdit\app` (about half a minute). Every later launch opens in about
  a second.
- Dropping files on the shortcut while the app is already open opens them in the running app.

**Menus:** File (New Window Ctrl+N, Open Ctrl+O, Open Recent, Save Ctrl+S, Save As Ctrl+Shift+S,
Export SVG, Close Ctrl+W), Edit, View (Toggle Editor Pane Ctrl+B, Diagram Full Screen F11, zoom,
developer tools), Help (Mermaid syntax reference, Check for Updates, Open Log Folder, About).

**Hiding the editor:** click the tab on the left edge of the diagram, press Ctrl+B, or drag the
divider all the way left. The layout is remembered. **Full screen** (the ⤢ button at the top
right of the diagram, or F11) shows only the diagram. Press Esc or the same button to exit.

## Opening `.mermaid` files from Explorer

Each time the app starts, it registers itself for the current Windows user as an **Open with**
choice for `.mermaid`, `.mmd` and `.md` files. No administrator rights are needed. To make it the
default for a type:

1. Right-click a `.mermaid` file and choose **Open with > Choose another app**.
2. Pick **Mermaid View Edit** and click **Always**.

Windows only lets you make that choice; a program cannot set itself as the default. The choice
carries over to new versions, because every version registers under the same name and points it
at the exe that ran last. To remove the registration, delete these keys under
`HKEY_CURRENT_USER\Software\Classes`: `MermaidViewEdit.Diagram`, and the
`MermaidViewEdit.Diagram` value in `.mermaid\OpenWithProgids`, `.mmd\OpenWithProgids` and
`.md\OpenWithProgids`.

## Application data and settings

| What                                    | Where                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| Settings (recent files, last folder)    | `%LOCALAPPDATA%\MermaidViewEdit\settings.json`                                  |
| Editor state and History timeline       | `%LOCALAPPDATA%\MermaidViewEdit\browser\`                                       |
| Logs                                    | `%LOCALAPPDATA%\MermaidViewEdit\logs\app.log` (rotates at 1 MB), `launcher.log` |
| Unpacked app (about 400 MB per version) | `%LOCALAPPDATA%\MermaidViewEdit\app\<version>-<id>\`                            |

- **Reset:** quit the app and delete `%LOCALAPPDATA%\MermaidViewEdit`.
- **Unpacked copies:** when a version starts, it removes the unpacked copies of other versions
  that are not running. The release exes themselves are never touched. Running an older exe
  again simply unpacks it again.
- **Backup:** copy that folder (the `app\` subfolder can be skipped). Your diagrams themselves stay wherever you saved them.
- **Sensitive data:** the `browser\` folder holds the last diagram text and the History timeline,
  so it may contain privileged content. Logs contain file paths but never diagram contents.

## External services

None are required. The desktop build turns off analytics, Mermaid Chart promotions, and the
mermaid.ink / kroki.io share-link renderers, so diagram text is never uploaded by default. Links
to documentation or GitHub open in your default browser only when you click them.

## Updates

The app looks for `latest.json` in `<folder containing the exe>\updates\`. It checks 15 seconds
after start, then every 30 minutes, in the background. When a newer version is found and fully
synced, it asks **"Version X is available. Install now?"** If you say yes, it:

1. Verifies the file's size and SHA-256.
2. Copies the new exe next to the current one under its versioned name. Nothing is overwritten.
3. Creates a `Mermaid View Edit vX` desktop shortcut.
4. Starts the new version, then closes the old one.

If you have unsaved edits, it asks you to save them first. Files that are still syncing are
skipped quietly and checked again later. SHA-256 catches corrupt or partial copies, but it is
**not** a substitute for code signing.

To read updates from another folder, create `update_config.json` next to the exe:

```json
{ "update_directory": "D:\\Path\\To\\Dropbox\\MermaidViewEdit\\updates" }
```

## Side-by-side releases and rollback

Every version is a separate `Mermaid View Edit vX.Y.Z.exe` with its own desktop shortcut. To roll
back, run the older exe or shortcut. Settings are shared between versions.

## Building a new release

Prerequisites: Node.js 24+ (includes corepack/pnpm), .NET Framework 4.x (part of Windows; its C#
compiler builds the launcher), Python 3 with Pillow (only for icon changes), and an internet
connection for the first dependency download.

1. Make the change.
2. Increase `"version"` in `desktop\package.json`. This is the only version source.
3. Run `.\build.ps1 -ReleaseNotes "What changed"` from PowerShell.
4. Answer the Common Software question. The default is **No**.

`build.ps1` installs the locked dependencies, builds the editor, runs all tests, packages the exe,
verifies the copies in `installer\` and `updates\`, writes `updates\latest.json` last, and creates
the desktop shortcut. It refuses to overwrite an existing version.

Release smoke test: `.\scripts\smoke-test.ps1`. It launches the real exe and the shortcut with
test files, checks the manifest, icon, shortcut and error handling, and runs a Defender scan.

## Dependency maintenance

- Web app: `corepack pnpm install`, then commit `pnpm-lock.yaml`.
- Desktop: `cd desktop; npm install electron@<ver> electron-builder@<ver> --save-exact`.
- Pull upstream editor changes: `git fetch upstream; git merge upstream/master`. Desktop changes
  touch only a few upstream files, so conflicts should be rare.

## Icon

The source is `assets\make_icon.py`. Edit it and run `python assets\make_icon.py` to regenerate
`assets\app.ico` (16–256 px) and `assets\app-icon-preview.png`.

## Common Software publication

After a build, `build.ps1` asks whether to publish to
`D:\Curtis Law Firm Dropbox\Curtis Law Firm Team Folder\Common Software`. Only `y` or `yes`
approves; anything else leaves the folder untouched. On approval, `scripts\publish-common.ps1`:

- copies the exe to a temp name and verifies it, then renames it into place;
- only after that, deletes files there named exactly `Mermaid View Edit v<semver>.exe`, other than
  the new one;
- never deletes folders, shortcuts, other apps, or anything outside that folder.

To publish by hand: `.\scripts\publish-common.ps1 -ExePath ".\installer\Mermaid View Edit vX.Y.Z.exe"`.

## Troubleshooting

- **Help > Open Log Folder** shows `app.log`.
- **"Unsupported file type"**: rename the file to `.mmd` or `.mermaid`.
- **Markdown file won't open**: it needs a ` ```mermaid ` fenced block.
- **Diagram shows an error**: the error message is under the preview. The line is marked in the
  editor.
- **Update not offered**: check that `updates\latest.json` and the exe have finished syncing, and
  check the log for `update:` lines.
- **Blank window**: delete `%LOCALAPPDATA%\MermaidViewEdit\browser` and restart.

## Uninstall

Delete the exe(s), the desktop shortcut(s) and `%LOCALAPPDATA%\MermaidViewEdit`. Versions 1.0.0
and 1.1.0 also left `%TEMP%\MermaidViewEdit-*`. Also remove the registry keys listed under "Opening `.mermaid` files from Explorer".

## SmartScreen and code signing

The exe is unsigned. Windows SmartScreen may show "Windows protected your PC" the first time. Click
**More info > Run anyway** only for copies from the firm's own folders. An Authenticode
certificate would remove the warning, prove who published the file, and let updates be checked by
signature instead of checksum alone.

## Credentials

The app needs no credentials, and none are embedded in it. Anything placed in an exe can be
extracted by anyone who has a copy, so secrets must never be built in. If a future feature needs
one, use Windows Credential Manager or an environment variable.
