# Interface provenance

Sylloom’s terminal interface is adapted from
[velora-cli by Themistic](https://github.com/ThemisticLabs/velora-cli).
The original design is credited here and in the README. Sylloom is a separate tool;
it does not include Velora’s product mark, model engine, licensing or services.

## Adapted patterns

- `src/terminal/style.ts`: terminal color handling and the violet/ultramarine palette.
  This file is adapted from Velora’s `src/terminal/style.ts`.
- Header structure: a compact four-line mark, product name and version placement,
  following Velora’s `src/terminal/header.ts`.
- Alternate screen, margins, divider and footer placement, following
  `src/terminal/use-setup-screen.ts`.
- Selection marker, active-row accent, descriptions and scrolling lists, following
  `src/terminal/render-list.ts` and `src/setup/select-option.ts`.

Sylloom implements its own screen renderer for recording controls and asynchronous
state updates. Terminal width calculations preserve grapheme clusters and display
cells. The terminal’s font and theme remain user-controlled. `NO_COLOR`,
`FORCE_COLOR` and `TERM=dumb` are supported; `COLORFGBG` provides a limited hint,
not full theme detection.

## Original Sylloom mark

The seven-bar waveform in `assets/logo.svg` and `src/brand.ts` is original to
Sylloom. It replaces the previously borrowed mark. The README uses the SVG;
the terminal uses a four-row Unicode adaptation with the same seven bars.
No remote fonts or upstream brand images are required.

## Documents and dictation indicator

The Markdown renderer uses `marked` with terminal colors for headings, lists,
tables, quotes and code. Reading starts at the document beginning. HTML exports
are independent local files with system fonts, dark/light color schemes and print CSS.

The dictation indicator is a transparent 122 × 38 point AppKit panel driven from
TypeScript through Koffi. It displays only a 13-bar waveform, takes no focus and
passes clicks through. Microphone levels drive recording feedback. Gray indicates
processing and green confirms copying. The processing animation respects Reduce
Motion. The indicator’s waveform is a functional recording display, separate from
the static product mark.

See [NOTICE.md](NOTICE.md) for attribution and the unresolved project license.
