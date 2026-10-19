<p align="center"><img src="assets/logo.svg" width="112" height="112" alt="Sylloom waveform"></p>
<h1 align="center">Sylloom</h1>
<p align="center">Speak freely. Keep the words.</p>

Local dictation, meeting recording and structured notes from your terminal.
Built with TypeScript for macOS on Apple Silicon. No Python runtime or cloud API.

- **Dictate from any app.** Press Ctrl+Option+Space, speak, then press it again. Paste the formatted text with Cmd+V.
- **Record meetings.** Capture microphone and system audio separately, with device switching, pause and mute controls.
- **Choose what to keep.** Name each meeting and explicitly choose whether to keep a transcript, generate a note or delete the text.
- **Read and export.** Render Markdown in the terminal, open a local browser view, and export Markdown or HTML.

The terminal interface is adapted from [velora-cli by Themistic](https://github.com/ThemisticLabs/velora-cli).
Sylloom has its own waveform mark. See [design provenance](DESIGN.md) and [third-party notices](NOTICE.md).

## Install

Requires an Apple Silicon Mac, macOS 14.4 or later, and approximately 10 GiB of free
space for the default models, plus dependencies. 16 GiB of RAM is recommended.
The installer uses [Homebrew](https://brew.sh) for missing native dependencies.
Install Homebrew first if it is not already available.

Clone or download this repository, open its directory, then run:

```sh
./install.sh
./sylloom
```

The installer checks your Mac, installs Node.js if needed, installs `whisper-server`
and `llama-server`, runs `npm ci`, builds the CLI, and downloads all four models.
Downloads are checked against the model publisher’s size and SHA-256. Transfers
use bounded byte ranges with retries; interrupted downloads are not installed.
It creates a `sylloom` symlink in `~/.local/bin`. If that directory is on your PATH,
you can start Sylloom from anywhere with `sylloom`. Existing commands and saved
model selections are preserved. Keep the installed source directory in place.

```sh
./install.sh --check           # Check requirements without changes
./install.sh --dictation-only  # Download just Turbo and the formatter
./install.sh --skip-models     # Build without downloading models
./install.sh --no-link         # Use ./sylloom without creating a command
./install.sh --help
```

For a manual install with an existing Node.js 22.18+ installation:

```sh
brew install whisper.cpp llama.cpp
npm ci
npm run build
./sylloom models install all
./sylloom doctor
```

When macOS asks, allow microphone and system audio recording for your terminal
application under **System Settings → Privacy & Security**. These permissions
belong to your terminal host. Run `./sylloom doctor` to inspect devices and backends.

## Dictate from anywhere

Keep the CLI running, even when another app is in the foreground.

| Shortcut | Action |
| --- | --- |
| Ctrl+Option+Space | Start recording; press again to stop, transcribe and copy |
| Ctrl+Option+Esc | Cancel the current dictation |
| Cmd+V | Paste the copied text yourself |

A small, transparent waveform appears while dictation is active. It follows the
actual microphone level, turns gray during processing, and briefly green after
copying. It takes neither keyboard focus nor mouse clicks. The indicator contains
no labels or buttons and respects the system’s Reduce Motion preference.

```sh
./sylloom dictate
./sylloom dictate --listen                # Global shortcuts without the terminal UI
./sylloom dictate --listen --format email
```

Choose **Message**, **Email** or **List** in Settings. Dictation keeps the language
you spoke; it does not translate your message. The interface and generated meeting
notes are in English. Transcription language defaults to automatic detection;
set it to `en`, `de` or another supported language in Settings when useful.
The bundled formatter is intended for German and English.

Say “new paragraph”, “neuer Absatz” or “Absatzwechsel” for a paragraph break.
Dictation history retains the original transcript, formatted text and audio.
You can read, reformat, copy or explicitly delete each dictation. Canceling a new
dictation removes it; canceling a reformat preserves the saved version. Empty or
failed results are not copied. Sylloom never inserts or sends text automatically.
Closing the CLI stops capture and unregisters the global shortcuts.

### Dictation latency

Whisper and the formatter preload when recording starts. Transcription still
begins only after stopping. Models stay warm for 120 seconds after copying, then
release their memory. Canceling, closing or starting another processing task
also releases them. Set the warm period to 0–600 seconds in Settings.

Automatic polish passes through already capitalized and punctuated messages.
Correction, filler, enumeration and spoken-number cues invoke the formatter;
emails and lists always invoke it. This detection uses heuristics. Choose
**Dictation polish → Always use model** to format every message with the model.

A local comparison on an M4 with two synthetic German samples measured:

| Sample | Previous pipeline | Optimized, first run | Optimized, repeated |
| --- | --- | --- | --- |
| Short message | 7.6 s | 1.9 s | 1.0 s |
| Correction and two paragraphs | 9.0 s | 5.9 s | 4.2 s |

These measurements cover saved audio to clipboard without recording-time preload.
The two examples produced identical text. Actual latency and recognition vary
with hardware, audio length and model settings. Turbo may recognize speech
differently from full large-v3.

## Record a meeting

Choose **Start recording**. Microphone and system audio have separate levels,
devices and health states, and are saved as separate 16 kHz mono WAV files.

| Key | Action |
| --- | --- |
| ↑ / ↓, Enter | Select an action |
| Space or P | Pause / resume |
| I / O | Switch microphone / captured output device |
| M | Mute / unmute microphone |
| S or Ctrl+C | Stop and open the finish flow |
| Esc | Return from a subview |

**Follow system default** checks device changes every two seconds. A disconnected
pinned device falls back to the default and is selected again when it returns.
Switching may leave a short gap, preserved as silence on the recording timeline.
Choosing an output changes what is captured; it does not change macOS playback.
Pause saves no audio. Muting saves silence for that track. Headphones help prevent
the microphone from recording the speakers a second time.

No meeting transcription or note generation runs during capture. After stopping:

1. Name the recording.
2. Choose **Keep structured note and transcript**, **Keep structured note only**,
   **Keep transcript**, or **Delete transcript, keep audio**.
3. Review the resulting document.

There is no default transcript decision. An unfinished recording stays pending
after closing or crashing. Audio stays with every finish option, including text
deletion. “Note only” deletes transcript chunks only after the note is saved.
Note drafts cover discussion, decisions, open questions, actions and risks.
Empty sections and placeholder actions are omitted. Action owners and dates need
support from the original source quote; unknown values are omitted. Model-generated
notes can still contain semantic errors, so review the draft against the transcript.

## CLI commands

```sh
./sylloom record --headless
./sylloom record --headless --duration 60
./sylloom control status
./sylloom control pause
./sylloom control resume
./sylloom control input default
./sylloom control output default
./sylloom control mute-mic
./sylloom control mute-system
./sylloom control stop
./sylloom devices
./sylloom list
./sylloom finish RECORDING-ID --name 'Planning' --action summarize
```

`finish --action` accepts `summarize`, `note-only`, `keep` and `delete`.
A local socket with mode `0600` controls recording; it is not a network service.
A data-directory lock prevents two active controllers. Headless Ctrl+C stops
capture; naming and the finish decision remain explicit.

```sh
./sylloom show                        # Latest saved note, rendered in terminal
./sylloom show RECORDING-ID --transcript
./sylloom show --raw                  # Original Markdown
./sylloom open                        # Local browser reading view
./sylloom export -o ~/Desktop/note.md
./sylloom export -o ~/Desktop/note.html
./sylloom reprocess RECORDING-ID       # Transcribe existing audio again
```

The document viewer starts at the top. Use arrow keys, PgUp/PgDn, Home/End, and Esc.
HTML exports have no external resources and can be printed from your browser.
Exports preserve existing files unless you explicitly pass `--force`.
Deleting a transcript removes Sylloom’s cached browser copy, but not exports you
created yourself. Reprocessing requires a new finish decision.

## Models and local data

| Role | Default model | Approximate download |
| --- | --- | --- |
| Meeting transcription | [Whisper large-v3, FP16](https://huggingface.co/ggerganov/whisper.cpp) | 2.9 GiB |
| Dictation transcription | [Whisper large-v3-turbo, FP16](https://huggingface.co/ggerganov/whisper.cpp) | 1.5 GiB |
| Meeting notes | [Qwen3 4B Q4_K_M](https://huggingface.co/Qwen/Qwen3-4B-GGUF) | 2.3 GiB |
| Dictation polish | [Qwen3.5 4B Parakeet Formatter](https://huggingface.co/justusraw/Qwen3.5-4B-Parakeet-formatter) | 2.6 GiB |

Install individually with `./sylloom models install whisper`, `dictation-whisper`,
`llama` or `formatter`. `all` installs all four; `both` installs meeting models only.
`--keep-selection` downloads without changing saved selections, as the installer does.
Settings also accepts custom compatible model files. Meeting notes can use an
already installed Ollama model through a loopback-only HTTP endpoint. There is no
remote model endpoint or cloud fallback. Model terms remain with their publishers.

Everything is stored under the local, git-ignored `data/` directory by default:

```text
data/
  settings.json
  models/
  recordings/<id>/
    session.json
    mic.wav
    system.wav
    chunks/
    transcript.md
    note.md
  dictations/<id>/
  exports/
  views/
```

Set `SYLLOOM_HOME=/your/chosen/directory` before starting to move local data.
`MEETING_HOME` remains a compatibility alias. Existing settings are preserved.
Recordings and transcripts are not uploaded. Installation contacts Homebrew, npm
and the model repositories to obtain dependencies and weights. Storage uses
restrictive permissions, without additional application-level encryption.
Global hotkeys register specific combinations; they do not log other keystrokes.

Current limits: macOS on Apple Silicon is the tested platform; Windows and Linux
are not supported releases. No speaker identification, acoustic echo cancellation
or guaranteed gapless device switching. WAV tracks are limited to about 37 hours.
Dictation formatting is limited to 12,000 characters and 24 paragraphs.

## Development and release preparation

```sh
npm ci
npm run check
npm test
npm run build
npm run release:check
npm run release:prepare
```

Release preparation creates `release/sylloom-<version>-source.tar.gz`, a source
manifest and an archive SHA-256. A fixed file allowlist excludes local data,
weights, dependencies, built output, Git metadata and this workspace’s other
projects. It also scans exported text for private user paths, local usernames,
email addresses and common credential patterns. Add extra private terms through
`SYLLOOM_PRIVACY_TERMS` as a comma-separated environment variable. Inspect the
archive before uploading; a pattern scan cannot identify every possible secret.
No command creates a repository, adds a remote, commits or pushes anything.

Optional native/model checks require FFmpeg and the macOS German “Anna” voice:

```sh
brew install ffmpeg
npm run verify:local                  # Synthetic meeting → transcription → note → export
npm run verify:local -- --audio       # Also tests actual capture and device controls
npm run verify:dictation              # Synthetic dictation → real clipboard; restores it
npm run verify:dictation -- --audio   # Also tests microphone preload and cancellation
npm run benchmark:dictation
```

QA uses temporary data directories and fictional samples. German fixtures are
intentional: they exercise Unicode and verify that dictation preserves its language.
Never add real recordings, device exports, model weights, `.env` files or local QA
results to a public source tree. See [AGENTS.md](AGENTS.md) for repository rules.

## License status

A project license has not been selected. The package is marked `UNLICENSED` and
private to prevent accidental npm publication. Public source availability does
not change upstream license terms. See [NOTICE.md](NOTICE.md).
