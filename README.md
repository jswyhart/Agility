# Agility

A cross-platform desktop PDF editor for macOS, Windows and Linux, built with
Electron, [pdf.js](https://mozilla.github.io/pdf.js/) (rendering and text),
[pdf-lib](https://pdf-lib.js.org/) + fontkit (editing and saving) and
[Tesseract.js](https://tesseract.projectnaptha.com/) (OCR).

## Features

**Reading**
- Tabs: each document opens in its own tab; drag a PDF onto the window, use File ▸ Open, or Open Recent (also on the welcome screen).
- Continuous scroll, page thumbnails, zoom (fit width/page, presets, ⌘/Ctrl + scroll or pinch), find in document.
- Select and copy the document's text, including text recognized by OCR.

**Editing text**
- **Edit PDF text** (X): click a paragraph to edit it as one block that reflows to its original width and line spacing as you type (Alt-click edits a single line; resizing the box rewraps it), or click a standalone line to retype it. The original is removed from the page content, not covered, and the replacement keeps its size, color and position. It uses the document's own font when that font (embedded, or the same font installed on this computer) has every character needed; otherwise the closest standard font.
- **Text boxes** (T) in Sans, Serif or Mono with bold and italic. Characters beyond Latin-1 (Cyrillic, Greek, symbols…) use bundled DejaVu fonts.
- Click places the cursor, double-click selects a word, triple-click selects the whole line.

**Markup and comments**
- Select text, then highlight, underline or strike it from the popup (or press H / U), or drag across text with the Highlight, Underline (U) and Strike (K) tools. Away from text, the highlighter draws a box.
- Pen, rectangle, ellipse, line, arrow, whiteout, images, and checkmark/cross/dot stamps.
- **Comments** (N): sticky notes with threaded replies. Any highlight or shape can carry a note. The comments panel (⇧⌘C) lists everything by page.
- Markup is saved as **standard PDF annotations**, so Acrobat, Preview and others show it, and Agility reopens it as editable. *File ▸ Save Flattened Copy* bakes it into the page instead.

**Fill & Sign**
- Fill form fields; add new text, checkbox and dropdown fields.
- Signatures, drawn or typed in one of four script fonts, can be remembered on this computer.
- Date stamps and check/cross/dot marks.

**Redaction**
- Mark areas (D), or select text and choose *Redact*. Then use *Tools ▸ Apply Redactions*.
- Applying removes the text under each mark from the file, glyph by glyph, with the rest of the line kept in place. Markup, links and form fields underneath go too, the areas are blacked out, and the replaced data is deleted from the file.
- If an image lies under a mark, the page is rebuilt as an image with the areas burned in, and its remaining text is kept as an invisible searchable layer.

**OCR**
- Recognize text on scanned pages (current page or all), offline, with the bundled English model.
- Recognized text can be searched, selected, copied and edited, and is saved as an invisible text layer.

**Pages and documents**
- Rotate, delete, insert blank pages, reorder by dragging thumbnails, and combine PDFs.
- Extract pages, split into files, and crop.
- Page numbers, header & footer (`{page}`, `{pages}`, `{date}`, `{file}`), and watermarks.
- *Reduce File Size* re-saves large images at a lower resolution and drops unused data.
- *Save with Password* writes an AES-128 encrypted copy, with print, copy and edit permissions.
- **Password-protected PDFs** (RC4, AES-128 and AES-256) open for editing after you enter the password, and are saved with the same password and permissions. If the author disallowed editing, the document stays read-only until you *Unlock* it with the owner password. *Remove Password* saves it unprotected. Decrypted copies are never written to the crash-recovery folder.
- Export pages as PNG or JPEG, export text, and create a PDF from images.

**Safety**
- Undo and redo for everything.
- Unsaved tabs are snapshotted every few seconds and offered back after a crash.

### Shortcuts

| Key | Tool | | Key | Action |
|---|---|---|---|---|
| V | Select / select text | | ⌘/Ctrl O | Open (new tab if needed) |
| X | Edit PDF text | | ⌘/Ctrl T / W | New tab / close tab |
| T | Text box | | ⌘/Ctrl S / ⇧S | Save / Save As |
| N | Comment | | ⌘/Ctrl Z / ⇧Z (Ctrl Y) | Undo / Redo |
| H / U / K | Highlight / Underline / Strike | | ⌘/Ctrl F | Find |
| P, R, E, L, A | Pen, rectangle, ellipse, line, arrow | | ⌘/Ctrl E | Edit PDF text |
| W | Whiteout | | ⇧⌘/Ctrl O | Recognize text (OCR) |
| D | Mark for redaction | | ⇧⌘/Ctrl C | Comments panel |
| I / S | Image / Signature | | ⌘/Ctrl R / ⇧R | Rotate page |

With text selected, H highlights it and U underlines it. With a text box selected, H toggles its highlight.

## Development

```bash
npm install
npm start
npm test        # end-to-end tests against the real app (Playwright)
```

npm 11 may block Electron's install script. If `npm start` says Electron failed to install, run `node node_modules/electron/install.js` once.

Set `AGILITY_APP` to a packaged app's executable to run the same tests against a build. Tests launch Agility with its own profile. `AGILITY_TEST_DIR` makes save and open dialogs non-interactive, and saved files land in that folder. Fixtures live in `tests/fixtures/`.

## Building installers

```bash
npm run dist:mac     # .dmg + .zip (arm64 and x64)
npm run dist:win     # NSIS .exe installer (x64 and arm64)
npm run dist:linux   # AppImage + .deb
```

Build each platform on that OS. The GitHub Actions workflow (`.github/workflows/build.yml`) runs the tests, then builds all three when you push a `v*` tag or run it manually. The builds are unsigned: macOS Gatekeeper and Windows SmartScreen will warn until you add signing certificates (see the comments in the workflow and the [electron-builder code-signing docs](https://www.electron.build/code-signing)).

## Releasing, signing and updates

1. In `package.json`, set `build.publish[0].owner` (and `repo`) to your GitHub repository.
2. Add the signing secrets to the repository. Builds still work without them, but unsigned.
   - **macOS** (Developer ID + notarization): `MAC_CERT_P12` (base64 of your *Developer ID Application* .p12), `MAC_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. Builds use the hardened runtime with `build/entitlements.mac.plist`.
   - **Windows**: `WIN_CERT_PFX` (base64 .pfx) and `WIN_CERT_PASSWORD`. Azure Trusted Signing can be configured in `build.win` instead.
3. Push a tag such as `v0.2.0`. CI runs the tests on macOS, Windows and Linux, then builds all three and publishes a GitHub Release with the update metadata (`latest*.yml`).

Installed copies check that release feed at startup and every few hours (*Check for Updates…* in the app or Help menu). They download in the background and offer to restart. Updates work for the macOS zip/dmg, the Windows installer and the Linux AppImage.

To build locally: `npm run dist:mac` on a Mac. Linux AppImages (`npx electron-builder --linux AppImage`) and Windows installers (`--win nsis`) can also be cross-built from macOS, but test them on their own systems.

## How it works

- `main.js` handles windows, tabs (one isolated editor view per document), menus, dialogs, disk access, recent files, crash-recovery snapshots, saved signatures, the installed-font index and OCR. It serves the UI over a private `app://` scheme to sandboxed renderers.
- `src/app.js` is the editor. Page structure changes are applied immediately with pdf-lib. Markup lives as editable objects until saved.
- `src/textedit.js` parses page content streams and tracks text positions. It removes edited lines and redacted glyphs, keeping later text in place, and deletes the data they replace.
- `src/pdfannots.js` writes markup as PDF annotations with appearance streams, and reads Agility's annotations back.
- `src/fonts.js` picks the font for written text and makes the same choice for preview and save.
- `src/pagetools.js` and `src/crypto.js` hold the page tools and the AES-128 security handler.

## Limitations

- **Edited text gets its own font object.** A line that mixes styles takes the style of its first word. When no matching font is available, a standard font is used.
- **Some text can't be removed.** Text inside embedded form objects, or written top-to-bottom, can't be removed in place. Edit Text covers and retypes it, and redaction rasterizes that page.
- **Scanned edits paint over the scan.** Editing scanned text covers the old pixels and retypes the line.
- **Certificate-encrypted PDFs are view-only.** Only password (Standard) security can be unlocked for editing.
- **OCR is English only.** It uses the bundled English model; other languages can be added with more `@tesseract.js-data/*` packages.
