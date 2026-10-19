# Attribution and third-party notices

## Velora CLI

The terminal layout, interaction patterns and color handling are adapted from
[velora-cli](https://github.com/ThemisticLabs/velora-cli), created by Themistic.
`src/terminal/style.ts` includes adapted source from that project. The terminal
screen renderer is implemented in Sylloom; its design references are documented
in [DESIGN.md](DESIGN.md). Velora’s original mark is not included.

No license file was present in the upstream checkout inspected during preparation.
No license grant is inferred or added on its behalf. Sylloom’s project license
remains undecided; the package is marked `UNLICENSED`. Resolve the licensing of
adapted code before offering the project under an open-source license.

## Runtime dependencies

These packages retain their own license notices, distributed with their npm packages:

- [flexaudio](https://github.com/Studio-Sadola/flexaudio): native audio capture, MIT.
- [Koffi](https://koffi.dev): native API access, MIT.
- [Commander](https://github.com/tj/commander.js): CLI command parsing, MIT.
- [ical.js](https://github.com/kewisch/ical.js): local ICS parsing, MPL-2.0.
- [marked](https://github.com/markedjs/marked): Markdown parsing, MIT.
- [sanitize-html](https://github.com/apostrophecms/sanitize-html): HTML sanitization, MIT.
- [slice-ansi](https://github.com/chalk/slice-ansi) and
  [string-width](https://github.com/sindresorhus/string-width): terminal text measurement, MIT.

[whisper.cpp](https://github.com/ggml-org/whisper.cpp) and
[llama.cpp](https://github.com/ggml-org/llama.cpp) are installed separately.
Their terms and those of their dependencies remain with their upstream projects.

## Models

Model weights are downloaded separately, never bundled in the public source archive:

- [Whisper large-v3 and large-v3-turbo GGML](https://huggingface.co/ggerganov/whisper.cpp).
- [Qwen3 4B GGUF](https://huggingface.co/Qwen/Qwen3-4B-GGUF).
- [Qwen3.5 4B Parakeet Formatter](https://huggingface.co/justusraw/Qwen3.5-4B-Parakeet-formatter).

Consult each model repository for its current license, base-model terms and model
card. Download metadata records the selected upstream revision and SHA-256 beside
the local file. Sylloom does not train these models or send recordings to their authors.
