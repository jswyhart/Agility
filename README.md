# Agility

A cross-platform desktop PDF editor for macOS, Windows and Linux, built with
Electron, [pdf.js](https://mozilla.github.io/pdf.js/) (rendering and text),
[pdf-lib](https://pdf-lib.js.org/) + fontkit (editing and saving) and
[Tesseract.js](https://tesseract.projectnaptha.com/) (OCR).

## Features

**Reading**
- Tabs: each document opens in its own tab; drag a PDF onto the window, use File ▸ Open, or Open Recent (also on the welcome screen). Drag tabs to reorder them or out of the strip for a window of their own; right-click a tab to close the others, show the file in its folder or copy its path. A closed tab can be reopened, closing the last document leaves a start page, and the documents open when you quit come back at the next launch. When tabs don't fit they scroll, with a ▾ menu listing them all.
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
- **Certificate signatures** (*Sign with Certificate…*): sign with a certificate from your organization or a certificate authority (.p12/.pfx), or create a self-signed one. You can add a reason, a location and a visible signature box. Opening a signed PDF shows whether each signature is intact, whether the file changed after signing, and whether the signer's identity is verified by a trusted authority. Editing a signed document warns that saving will invalidate the signature. *Add a trusted timestamp* asks a timestamp authority (RFC 3161; DigiCert's public server by default, or your own) to confirm when you signed, so the signature can still be checked after your certificate expires; only a fingerprint of the signature is sent.
- **Form authoring:** *Detect form fields* finds fill-in lines, boxes, checkbox squares and underscore blanks on flat forms, and names each field after its label. *Edit form fields* lets you click a field to change its name, tooltip, required/read-only, value, multi-line, max length, font size, alignment or choices, or delete it. *Tab order* orders fields by rows, by columns, or by document structure.

**Redaction**
- Mark areas (D), or select text and choose *Redact*. Then use *Tools ▸ Apply Redactions*.
- Applying removes the text under each mark from the file, glyph by glyph, with the rest of the line kept in place. Markup, links and form fields underneath go too, the areas are blacked out, and the replaced data is deleted from the file.
- If an image lies under a mark, the page is rebuilt as an image with the areas burned in, and its remaining text is kept as an invisible searchable layer.

**OCR**
- Recognize text on scanned pages (current page or all), offline, with the bundled English model.
- Recognized text can be searched, selected, copied and edited, and is saved as an invisible text layer.

**Bookmarks and links**
- The Bookmarks tab shows the document's outline. Click to jump; add (+), rename (double-click), delete, reorder and nest bookmarks. The outline is only rewritten on save if you changed it.
- The document's own links work with the Select tool. The Link tool adds links to web pages or to pages in the document; ⌘/Ctrl-click follows them while editing.

**Compare**
- *Tools ▸ Compare with Another PDF* treats the open document as the newer version. It lists every changed, added and removed passage with word-level highlights, tints those lines in the document, marks removals, and jumps to each change.

**Pages and documents**
- Rotate, delete, insert blank pages, reorder by dragging thumbnails, and combine PDFs.
- Extract pages, split into files, and crop.
- Page numbers, header & footer (`{page}`, `{pages}`, `{date}`, `{file}`), and watermarks.
- *Reduce File Size* re-saves large images at a lower resolution and drops unused data.
- *Save with Password* writes an AES-128 encrypted copy, with print, copy and edit permissions.
- **Password-protected PDFs** (RC4, AES-128 and AES-256) open for editing after you enter the password, and are saved with the same password and permissions. If the author disallowed editing, the document stays read-only until you *Unlock* it with the owner password. *Remove Password* saves it unprotected. Decrypted copies are never written to the crash-recovery folder.
- **Batch processing** (*Tools ▸ Batch Process PDFs*): run OCR, a watermark, page numbers, file-size reduction and/or a password over many files at once, saving the results to a folder.
- Export pages as PNG or JPEG, export text, export to Word (.docx), and create a PDF from images or from Office files. Office conversion uses LibreOffice when installed; without it, Word .docx and Excel .xlsx/.csv still convert using built-in converters.

**Settings** (⌘/Ctrl ,)
- Your name for comments, light/dark/system appearance, the zoom documents open at, default colors per tool, default font, size and line width, and whether crash-recovery snapshots are kept. Settings apply to all tabs at once.

**Accessibility and archiving**
- *Document Properties*: title, author, subject, keywords and language, and showing the title in viewers.
- *Check Accessibility*: title, language, tagging, real text on every page, figure alternate text (tagged files), form field and link descriptions, security settings and embedded fonts. One-click fixes where possible: properties, OCR, generated field and link descriptions, **tags for untagged documents** (headings by text size, paragraphs and images in reading order) and alternate text for figures.
- *Save as PDF/A*: a PDF/A-2b copy with XMP metadata, an sRGB output intent (a generated standard profile), embedded fonts for text Agility writes, no scripts, and printable annotations. It lists anything it can't fix, such as fonts the original never embedded. Not checked with a formal validator such as veraPDF.

**Safety**
- Undo and redo for everything.
- Unsaved tabs are snapshotted every few seconds and offered back after a crash.

### Shortcuts

| Key | Tool | | Key | Action |
|---|---|---|---|---|
| V | Select / select text | | ⌘/Ctrl O | Open (new tab if needed) |
| X | Edit PDF text | | ⌘/Ctrl T / W / ⇧T | New tab / close tab / reopen closed tab |
| | | | Alt 1…9 (⌃1…9 on Mac) / F6 | Go to tab (9 = last) / keyboard focus to the tab bar |
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

## Windows MSIX package

Agility also ships as an MSIX package, for the Microsoft Store and managed installs. Electron apps can't be pure UWP apps: MSIX packages this one as a full-trust desktop app, so every feature works as it does in the regular build. Windows handles install, removal and updates, and the app's own updater turns itself off.

Build with `npm run dist:msix` on Windows, or use the `msix` job in CI, which builds x64 and arm64 and then installs and launches the x64 package. (On a Mac, electron-builder needs a Parallels Windows VM.) Package identity is under `build.appx` in `package.json`, and logos are generated by `npm run icon` into `build/appx`.

- **Testing a CI build:** without certificate secrets, CI signs with a throwaway certificate and uploads it as `Agility-test-certificate.cer`. Import it into *Local Machine ▸ Trusted People* as an administrator, then double-click the `.msix`.
- **Your own certificate:** add the `WIN_CERT_PFX` and `WIN_CERT_PASSWORD` secrets, plus `MSIX_PUBLISHER` with the certificate's exact subject.
- **Microsoft Store:** `build.appx` holds the Partner Center identity for Agility (Store ID 9N5ZDSBDQHQN, package family `swyhart.Agility_hvf2zc3emf56r`). Upload the `.msix` in Partner Center; the Store re-signs it, so no certificate of your own is needed for Store releases.

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
- **Signatures carry no revocation data.** A trusted timestamp proves when a document was signed, but Agility doesn't embed or check certificate revocation (OCSP/CRL). A certificate is trusted when it chains to the root certificates bundled with Node.js.
- **Added tags are worked out from the layout.** Tagging an untagged PDF finds headings, paragraphs and images, in the order the page draws them. It doesn't recognize lists or tables, doesn't tag links or form fields, and can't see text inside embedded form objects. Exporting a tagged PDF from the source document is more exact.
- **OCR is English only.** It uses the bundled English model; other languages can be added with more `@tesseract.js-data/*` packages.
