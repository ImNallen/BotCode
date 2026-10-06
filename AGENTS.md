# Bot Code

For UI changes, read [the UI baseline](docs/ui-baseline.md) before editing.

Use T3 Code as the style and layout reference. Preserve the left conversation sidebar, centered chat and bottom composer, optional right tools panel, compact header, and neutral system colors. Improve individual workflows within that familiar structure. The previous permanent center code pane and purple theme are examples of drift from this baseline.

Expose controls when their behavior works. Verify layout changes in the actual Tauri app using a disposable repository and an isolated `BOT_CODE_DATA_DIR`.
