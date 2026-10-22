# Folio PDF

A cross-platform desktop PDF editor for macOS, Windows and Linux, built with
Electron, [pdf.js](https://mozilla.github.io/pdf.js/) (rendering) and
[pdf-lib](https://pdf-lib.js.org/) (editing and saving).

## Features

- **Viewing**: continuous scroll, page thumbnails, zoom (fit width/page, presets, ⌘/Ctrl + scroll or pinch), page jump, find in document.
- **Markup**: text boxes, freehand pen, area highlight, rectangle, ellipse, line, arrow, whiteout, images (PNG/JPEG/WebP/GIF/SVG), and drawn signatures. You can select, move, resize, recolor, nudge with the arrow keys, and delete them.
- **Forms**: fill AcroForm text fields, checkboxes, radio buttons and dropdowns.
- **Pages**: rotate, delete, insert blank pages, reorder by dragging thumbnails, combine with another PDF, and extract a page to a new file.
- **Files**: Save / Save As, drag-and-drop to open, open PDFs from Finder/Explorer ("Open With"), unsaved-changes prompt, printing.
- **Undo / redo** for every edit, including page operations.

### Shortcuts

| Key | Tool |  | Key | Action |
|---|---|---|---|---|
| V | Select | | ⌘/Ctrl O | Open |
| T | Text | | ⌘/Ctrl S / ⇧S | Save / Save As |
| P | Pen | | ⌘/Ctrl Z / ⇧Z (Ctrl Y) | Undo / Redo |
| H | Highlight | | ⌘/Ctrl F | Find (Enter / ⇧Enter for next / previous) |
| R / E | Rectangle / Ellipse | | ⌘/Ctrl = / − / 0 | Zoom in / out / 100% |
| L / A | Line / Arrow | | ⌘/Ctrl 1 / 2 | Fit width / page |
| W | Whiteout | | ⌘/Ctrl R / ⇧R | Rotate page |
| I / S | Image / Signature | | ⌘/Ctrl B | Toggle thumbnails |

Hold Shift while drawing to snap lines to 45° and keep shapes square. Double-click a text box to edit it.

## Development

```bash
npm install
npm start
```

npm 11 may block Electron's install script. If `npm start` says Electron failed to install, run `node node_modules/electron/install.js` once.

## Building installers

```bash
npm run dist:mac     # .dmg + .zip (arm64 and x64)
npm run dist:win     # NSIS .exe installer (x64 and arm64)
npm run dist:linux   # AppImage + .deb
```

Build each platform on that OS. The included GitHub Actions workflow
(`.github/workflows/build.yml`) builds all three when you push a `v*` tag or
run it manually. The builds are unsigned: macOS Gatekeeper and Windows
SmartScreen will warn until you add signing certificates (see the comments in
the workflow and the [electron-builder code-signing docs](https://www.electron.build/code-signing)).

To regenerate the app icon (`build/icon.png`), run `npm run icon`.

## How it works

- `main.js` handles windows, menus, file dialogs and disk I/O. It serves the UI over a private `app://` scheme. The renderer is sandboxed with context isolation, and only files the user opened or picked can be written.
- `src/app.js` is the editor. Page structure changes (rotate, reorder, insert, delete, combine) are applied to the PDF straight away with pdf-lib. Markup stays as editable overlay objects until you save. Saving draws them into the page content and writes form values.

## Limitations

- **Saved markup is flattened.** Saving draws markup into the page content, so it can't be edited after you reopen the file. It stays editable while the document is open.
- **Whiteout is not redaction.** It covers content visually, but the text underneath can still be selected and extracted.
- **Existing text can't be edited.** Cover it with whiteout and add a text box instead.
- **Fonts are limited.** Text boxes use Helvetica (Latin/WinAnsi characters). Other characters are saved as "?".
- **Encrypted PDFs are read-only.** They open for viewing (with a password prompt if needed) but can't be saved with edits.
