# Attribution and third-party notices

## Sylloom

Sylloom is distributed under the [MIT License](LICENSE). The license covers the
Sylloom source code and the interface adaptations included in this repository.
Third-party dependencies and assets retain their own terms, listed below.

## Velora CLI

The terminal layout, interaction patterns and color handling are adapted from
[velora-cli](https://github.com/ThemisticLabs/velora-cli), created by Themistic.
`src/terminal/style.ts` includes adapted source from that project. The terminal
screen renderer is implemented in Sylloom; its design references are documented
in [DESIGN.md](DESIGN.md). Velora’s original mark is not included.

This repository's MIT license does not change the license of the upstream
Velora project or include its product mark, model engine or services.

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

## Website assets

Ocean photographs use the Unsplash License. Instrument Sans and Instrument Serif
use the SIL Open Font License. See [website credits](website/credits.html) for
sources and the bundled font license notices.
