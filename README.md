<p align="center"><img src="assets/logo.svg" width="112" height="112" alt="Sylloom waveform"></p>
<h1 align="center">Sylloom</h1>
<p align="center">Speak freely. Keep the words.</p>

Local dictation, meeting recording and structured notes from your terminal.
Built with TypeScript for macOS on Apple Silicon. No Python runtime or cloud API.

> Sylloom started as a one-day project to solve my own need for local dictation
> and meeting notes. I'm sharing it in case it helps someone else. I may leave
> it unmaintained at any time; ongoing support and updates aren't guaranteed.
> Feel free to use it, change it or fork it.

- **Dictate from any app.** Press Ctrl+Option+Space, speak, then press it again. Text is inserted into the focused input, or copied for Cmd+V.
- **Record meetings.** Capture microphone and system audio separately, with device switching, pause and mute controls.
- **Choose what to keep.** Name each meeting and explicitly choose whether to keep a transcript, generate a note or delete the text.
- **Read and export.** Render Markdown in the terminal, open a local browser view, and export Markdown or HTML.

The terminal interface is adapted from [velora-cli by Themistic](https://github.com/ThemisticLabs/velora-cli).
Sylloom has its own waveform mark. See [design provenance](DESIGN.md) and [third-party notices](NOTICE.md).

## Install

Requires an Apple Silicon Mac, macOS 14.4 or later, and at least 10 GiB of free
space for models, downloads and dependencies. 16 GiB of RAM is recommended.
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
It installs a `sylloom` launcher in `~/.local/bin` and adds that directory to your
shell PATH if needed (zsh, bash or fish). Open a new terminal after first-time PATH
setup. Then run `sylloom` from any directory. No `sudo` or global npm install is
needed. Unrelated commands and saved model selections are preserved. Keep the
installed source directory in place; the launcher starts that build and uses its
existing local data. It can also locate the installed Node runtime when Node is
missing from your shell PATH.

```sh
./install.sh --check           # Check requirements without changes
./install.sh --dictation-only  # Download just Turbo and the formatter
./install.sh --skip-models     # Build without downloading models
./install.sh --no-link         # Use ./sylloom without creating a command
./install.sh --no-path         # Install the command without editing shell startup files
./install.sh --help
```

For an already built checkout, register or repair the global command without
reinstalling dependencies or downloading models:

```sh
./sylloom install
./sylloom --version
./sylloom stats
```

Repeating `sylloom install` updates Sylloom's own launcher and avoids duplicate
PATH entries. `--bin-dir DIRECTORY` chooses another command directory;
`--no-path` leaves shell configuration unchanged. zsh uses `ZDOTDIR` when set.

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
| Ctrl+Option+Space | Start recording; press again to stop, transcribe and insert or copy |
| Ctrl+Option+Esc | Cancel the current dictation |
| Cmd+V | Paste when insertion falls back to the clipboard |

A compact waveform bubble appears at the bottom center of your display while
dictation is active. It opens from a droplet and contracts back down when finished,
matching the call popup animation. The waveform eases between samples and settles smoothly during silence.
The same trace is used by the website demo. The waveform follows the actual microphone
level, turns gray during processing and briefly green after delivery. The bubble
contains no labels, buttons or timer, takes no keyboard focus and passes clicks
through. Reduce Motion replaces the liquid transition with a short fade.

```sh
./sylloom dictate
./sylloom dictate --listen                # Global shortcuts without the terminal UI
./sylloom dictate --listen --format email
./sylloom preview-indicator               # Simulated waveform; no microphone capture
```

Choose **Message**, **Email** or **List** in Settings. Dictation keeps the language
you spoke; it does not translate your message. The interface and generated meeting
notes are in English. Transcription language defaults to automatic detection;
set it to `en`, `de` or another supported language in Settings when useful.
The default 0.6B formatter is [Spokenly Cleanup 1](https://huggingface.co/spokenly/cleanup-1-gguf).
It supports English, German, Spanish, French, Chinese, Russian and Japanese;
its publisher reports stronger quality in English. Whisper recognizes additional
languages. When Whisper reports a language outside that cleanup set, Sylloom
keeps the original wording and skips model cleanup. The Library shows the
recognized language. Choose **Settings → Models and performance → Recognition
language → Automatic detection** when switching languages. A fixed `de` setting
forces German recognition even when you speak English; Automatic can take longer.

Automatic formatting recognizes speech fillers, corrections and natural list
requests. Clear list and email layout is handled in code, without generating it
again. For example, “Meine To-do-Liste: Milch kaufen und Lea anrufen” becomes
a Markdown checklist; “Schreib mir eine Liste: …” produces a bullet list.
Empty endings such as “und eh ja” or “und ja, naja” are removed. Meaningful
affirmative answers and quoted words remain part of the text. A list ending such
as “und naja, keine Ahnung” is discarded, while a meaningful “Ich bin mir nicht
sicher, ob …” stays. “Milch und Brot einkaufen” remains one task. A list heading
recognized with a comma or period instead of a colon is still treated as a heading.
Lists can sit between ordinary paragraphs in the same dictation. An introduction
stays prose, repeated packing requirements become bullets, and the following
narrative returns to prose. Explicit to-do requests use checkboxes. Compound
objects such as “bread and butter” stay together, and self-corrections within an
item are cleaned without turning the rest of the message into a list.

Say “new paragraph”, “neuer Absatz”, “nächster Absatz” or “Absatzwechsel” for a
paragraph break when spoken as a standalone command. Discussing the phrase or
asking another person to add a paragraph remains dictated prose. English and
the other cleanup languages have corresponding standalone paragraph commands.
A repaired command such as “nächster Ansatz, nächster Absatz
meine ich” also starts a paragraph. An explicitly withdrawn final list item is
removed; quoted words remain literal. A formal greeting and sign-off can select
email layout even in Message mode. Ordinary requests stay prose, including
requests to draft an email. Longer prose gets paragraph breaks at clear topic
transitions or sentence boundaries without changing its words.
Dictation history retains the original transcript, formatted text and audio.
Every dictation is kept, including canceled, failed and interrupted recordings.
Read, rename, pin, reformat, copy or explicitly delete it from the Library.
**Reformat saved text** requests model formatting even when Automatic would skip
the text or formatting is switched off for new dictations. Explicit snippets
retain their exact saved text. Canceling a reformat preserves its previous saved version. Closing the CLI stops
capture, retains interrupted audio and unregisters the shortcuts.

### Personal words, corrections and snippets

Open **Settings → Words and snippets**. Add preferred spellings for names or
technical terms, explicit correction rules, or reusable spoken snippets. Every
entry has a full preview. **Use in draft** stages it; **Save changes** applies the
draft, and Esc discards it. Entries and the whole feature can be switched Off.
Everything stays in `speech-rules.json` in your local data directory.

Dictionary terms hint local recognition and preferred spelling; recognition can
still make mistakes. Corrections replace whole words once after formatting.
For example, `Silloom → Sylloom` leaves larger words, URLs, email addresses,
paths and Markdown code unchanged. Replacements do not trigger another rule.
Duplicate normalized triggers are rejected. Dictionary hints use the local
[Whisper server prompt parameter](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server#request-examples).

For a snippet, use a deliberate phrase such as **Textbaustein Signatur** and
enter the exact text, including paragraphs. Say that phrase by itself. A trailing
period is fine; a phrase inside a longer sentence does not expand. Snippets skip
the formatter and correction rules so their text stays exact. Activity counts
the spoken trigger, not all expanded words. Formatting Off skips only the model;
personal rules remain active until disabled separately.

Existing history and meeting transcripts are never changed automatically. In a
dictation's menu, **Edit formatted text** changes only that result. The multiline
editor supports paste, visual-line navigation, Enter for a line break and
**Ctrl+S** to save. Esc cancels. Failed saves retain the draft; original recognition,
audio and previous formatted versions stay available. Editing does not copy or
insert text and does not add spoken words to Insights. **Teach a correction for
future dictation** is a separate, explicit action. Reformat a saved result only
when you want to apply current rules to it.

```sh
sylloom rules word 'Sylloom'
sylloom rules correct 'Silloom' 'Sylloom'
sylloom rules snippet 'Textbaustein Signatur' --file signature.txt
sylloom rules preview 'Textbaustein Signatur.'
sylloom rules list
sylloom rules toggle RULE_ID
sylloom rules remove RULE_ID
sylloom rules disable
```

Rule-changing commands require the main CLI to be closed; use Settings to edit
rules while it runs. List and preview commands are read-only. An unreadable rules
file is preserved. If it cannot be loaded during dictation, Sylloom keeps the raw
transcript and uses its existing recovery path instead of applying unknown rules.

Automatic insertion is enabled by default. Allow **Accessibility** access for your
terminal under **System Settings → Privacy & Security → Accessibility**. Sylloom
captures the editable field and selection when you stop recording. Before inserting,
it checks that focus, selection and existing text have not changed. Web inputs use a
normal paste so Safari and other web editors receive their input events. Delivery
is confirmed against the field contents. Successful pasting restores the previous
clipboard, including its other formats, unless you copied something new meanwhile.
Unsupported inputs, password fields, missing permissions
or a changed focus fall back to the clipboard. Settings can disable insertion.
Sylloom never presses Enter or sends a message. History retries only copy.

If formatting fails after transcription, the original transcript is copied for
recovery. If no speech was recognized, the clipboard stays unchanged; the audio
remains available for retry. App support depends on its macOS Accessibility
implementation. This does not promise insertion into every editor or terminal.

## Library and Insights

**Library** searches names, structured notes, formatted dictations and original
transcripts together. Type to search; use **Tab** for All, Meetings, Dictations and
Needs attention, **Ctrl+P** for pinned items and **Ctrl+S** to change sorting.
New and completed dictations appear while the Library is open. **Ctrl+R** refreshes
it manually; search, filters and the selected item survive background updates.
Search ignores accents and requires all entered words. Titles rank above body
matches; pinned items stay at the top. Rename or pin from an item's menu.
Unreadable items are reported without preventing access to the rest of the Library.
Interrupted dictations with damaged audio stay visible under Needs attention with
their original files preserved. A corrupt activity ledger reports an error without
terminating the CLI or replacing the ledger.

**Settings** is grouped into Dictation, Global shortcuts, Recording and audio,
Outlook meeting reminders, Call recording prompts, Models and performance, Permissions,
and Storage and recovery. Switches use Velora's two-column **On / Off** list, with
Save and Discard pinned below the scrolling rows. Value pickers mark the current
selection; language and timing preferences offer presets and custom values. Use Enter or Space
to change them, **Save changes** to apply, or Esc to discard the draft, including
device choices and call-detection switches. Local calendar connections and Teams
credentials have separate actions within their categories: completing one of those explicit actions
applies immediately. Model actions also apply immediately and are labeled accordingly.

**Outlook meeting reminders** reads an explicitly connected local source and
shows a compact popup before a Teams meeting, five minutes ahead by default.
Change the lead time from 1–60 minutes or switch reminders Off in Settings.
There is no calendar screen or browser workspace. A reminder never records audio;
Open Teams is available only for a recognized Teams link and requires a click.

Connect through **Settings → Outlook meeting reminders → Local calendar connections**.
Source status reports partial or unavailable coverage. New Outlook can expose an
empty legacy scripting profile even while its current account has appointments.
When this is detected, Sylloom reports the connection as unavailable instead of
treating an empty result as a working calendar. Its newer proprietary local store
is currently unsupported. An existing macOS calendar or local ICS file is an
optional fallback. No add-in, extension, Graph connection or new login is needed.

**Call recording prompts** offers **Record / Dismiss** in a compact bottom-center
popup for FaceTime/iPhone calls reaching this Mac, native WhatsApp and Teams.
Each app has its own On / Off switch. Sylloom observes call controls and Core Audio
stream activity, with the local Teams device API as an additional source. This
observation reads activity flags, not audio samples. Audio activity can detect an
answered call; detecting the ringing stage depends on the app's exposed controls.
An audio-only signal is labeled **Audio session detected**, since other duplex
audio sessions are possible. Teams post-answer detection has been confirmed by a
user test. Ringing detection also observes its native notification helper and
app-attributed system banners; that new path still needs a real incoming-call
test. Notification bodies are skipped. Native WhatsApp still needs live verification.
An iPhone call relayed to the Mac has passed a post-answer popup/active/hangup
test. The popup did not appear during ringing in that test. An additional Apple
notification-button adapter is now included for that stage, but has not yet been
verified with a real incoming call. It requires Accessibility permission.

Popups emerge from the bottom center as a small droplet, stretch into a liquid
shape and open into the card with an elastic settle. Dismissal reverses the
motion, gathering the card back into a droplet. Text and buttons appear after the
shape opens, keeping their original layout. macOS Reduce Motion uses a short fade instead. Run
`sylloom preview-popups` to preview call, reminder and saved-recording popups
without recording audio. Close preview or Ctrl+C ends the preview.

Only clicking **Record** starts audio capture. Recording stops after a confirmed
hangup belonging to that same call; an unavailable detector keeps it running.
Teams microphone previews are treated as **joining**, so a recognized Join now
screen does not trigger a call prompt. If a recording was started from audio
activity before that screen was recognized, it continues through the preview.
Audio activity and pairing permissions alone cannot arm Teams auto-stop. A
not-in-meeting API message only ends the same call after that API confirmed it
was joined; otherwise confirmed native call controls are required. Without
confirmation, stop the recording manually. Repeated end messages retain the
confirmed hangup instead of canceling automatic stop.
Switch auto-stop Off under Recording and audio. Teams' local device API may need
enabling in its Privacy settings, or an administrator may disable it. A token is
stored only in macOS Keychain. Naming and the transcript decision always remain
in the CLI. Details: [local bridge](DESIGN.md#local-outlook-reminders-and-call-bridge).

**Ctrl+Option+C** copies the latest saved dictation from any app. If that newest
dictation has no text, it explicitly leaves the clipboard unchanged; it never
silently substitutes an older message. Dictation's latest-result entry remains
available after restart, including failed and canceled recordings. Library has
date/state filters under **Ctrl+F**, separate reformat/retranscribe actions and
recognition/formatting/total timings. Failed retries preserve the previous result.
**Storage and recovery** shows local usage and pending items; `sylloom recovery`
prints the same overview. `sylloom bridge` probes the configured local sources.
Recovery includes direct Finder access to the data folder and unreadable recording
folders. Library shows indexing details with **Ctrl+E**, keeping healthy results searchable.
If an interrupted meeting has a damaged audio track, recovery records the error
and preserves the original file while recovering its healthy tracks. The CLI can
still open; naming and the transcript decision remain pending.
Unreadable meeting metadata is listed with its preserved path. Dictation and
settings remain available; new meetings and reprocessing wait for metadata repair
so an unresolved transcript decision cannot be bypassed. **Storage and recovery →
Recover unreadable recording** shows every track and document before offering an
explicit metadata restore. Usable canonical PCM audio is required. The original
metadata is backed up before replacement; audio and existing notes/transcripts
are preserved. Name and time may be reconstructed; the recording stays pending
until you name it and choose what to keep. No restart is needed. Without usable
audio, inspect the folder and restore metadata from your own backup instead.
Invalid transcription checkpoints move to `chunks/rejected/` and are rebuilt from
saved audio on retry. Original checkpoint bytes and audio stay preserved.
The controller uses a kernel lock that releases on exit or a crash; an old
shutdown callback cannot unlock a new controller.

`sylloom status` distinguishes the source version, built CLI version, build
freshness and actual launcher target. `--json` gives the same details for scripts.
To update, enter the shown source directory, run `git pull --ff-only`, `npm ci`,
`npm run build`, then `./sylloom install`. If Git reports local changes, resolve
them first; do not discard them to update. Local data and model files stay in place.
Moving a checkout requires reinstalling its launcher from the new location.

**Insights** shows total spoken words, dictation count, weighted WPM, current and
longest streak, today's activity and a GitHub-style daily grid. Local calendar
days run Monday to Sunday. A streak stays active through yesterday until you dictate
today. Counts use original transcript words once per dictation, including recovered
speech. Retries do not add another dictation. Canceling without a transcript adds no
words. WPM uses recording time including pauses, not an estimate of active speech.
Meeting counts and notes are shown separately. Activity counts survive explicit
history deletion; the local ledger contains IDs, timestamps, durations and counts,
without transcript text. Existing history is backfilled on opening Insights.

Press **O** in Insights for a self-contained local dashboard with day details,
period filters and a downloadable PNG share card. **S** previews aggregate text
before opening an X composer. The browser version lets you edit that draft first.
Attach the downloaded card yourself. Nothing is posted automatically, and no
transcript, note title or app context is included. Browser views are snapshots;
reopen them from the CLI to refresh.

```sh
./sylloom library 'release import'
./sylloom library --type dictation --pinned --json
./sylloom stats
./sylloom stats --json
./sylloom stats --open
```

## Dictation latency

Whisper and the formatter preload in the background when the CLI starts, before
the first recording. The status shows “Warming local dictation models…” until
they are ready. The first capture reuses that startup promise if loading is still
in progress. No microphone is opened and no transcription runs during preload.
Transcription begins only after stopping. Models stay warm for 120 seconds after
delivery by default, then release their memory. Canceling, closing or starting
another processing task also releases them. Set the warm period to 0–600 seconds
in Settings. Off disables startup preload and releases models after each dictation.

Automatic formatting skips the model only for short, simple messages without
speech-editing cues. Capitals and punctuation do not prove a longer dictation is
already written text. Natural to-do/list requests, fillers, corrections and
spoken numbers invoke the formatter when needed. Recognized list layout, paragraph
commands, empty endings and email greeting/sign-off layout use code. The small
formatter handles semantic cleanup and self-corrections, using its trained plain
completion prompt and greedy decoding. Long inputs split at sentence boundaries
within its 4,096-token context; oversized sentences fail without truncating text.
Choose **Settings → Dictation → Formatting mode → Always** to run the model for
every dictation. The Library reports whether the formatter ran and the result changed.

An earlier pipeline comparison, before the current formatting corrections,
measured two synthetic German samples on an M4:

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

**Local models** groups setup by purpose: Dictation, Dictation formatting, Meeting
transcription and Meeting notes. Each row shows its status and selected model.
Open a row to install or select the recommended model, choose a custom file, or
configure the note backend. File paths stay in the custom-file dialog.

| Role | Default model | Approximate download |
| --- | --- | --- |
| Meeting transcription | [Whisper large-v3, FP16](https://huggingface.co/ggerganov/whisper.cpp) | 2.9 GiB |
| Dictation transcription | [Whisper large-v3-turbo, FP16](https://huggingface.co/ggerganov/whisper.cpp) | 1.5 GiB |
| Meeting notes | [Qwen3 4B Q4_K_M](https://huggingface.co/Qwen/Qwen3-4B-GGUF) | 2.3 GiB |
| Dictation polish | [Spokenly Cleanup 1, 0.6B Q8](https://huggingface.co/spokenly/cleanup-1-gguf) | 610 MiB |

Install individually with `./sylloom models install whisper`, `dictation-whisper`,
`llama` or `formatter`. `all` installs all four; `both` installs meeting models only.
`--keep-selection` downloads without changing saved selections, as the installer does.
Existing installations keep their selected formatter. Choose the fast model in
**Local models → Dictation formatting → Use recommended model**, or run
`sylloom models install formatter`. The previous Qwen3.5 4B fine-tune remains an
optional slower model in the same menu, or `sylloom models install formatter-quality`.
Settings also accepts custom compatible model files. Meeting notes can use an
already installed Ollama model through a loopback-only HTTP endpoint. There is no
remote model endpoint or cloud fallback. Model terms remain with their publishers.

Managed llama servers use a fresh, in-memory API key per process when the runtime
advertises `--api-key` with `LLAMA_API_KEY` support. The key is never saved or
printed. Older or custom binaries without that support retain loopback-only
access; update them to enable authentication. External Ollama remains user-managed.

Everything is stored under the local, git-ignored `data/` directory by default:

```text
data/
  settings.json
  usage.json
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
Recognition and cleanup can still mishear names or numbers. Review the result
before sending; the original transcript and audio remain available in Library.

## Development and release preparation

Dictation uses same-model prompt lookup on compatible Apple Silicon runtimes and
keeps its formatter context warm. Auto mode only regenerates message paragraphs
that need editing. See [runtime measurements and tradeoffs](PERFORMANCE.md),
including the local MLX comparison and the reproducible benchmarks.

The product page lives in `website/`. Run `npm run site` for a local preview at
`http://127.0.0.1:4173`, or `npm run site:build` for static files in `dist/site/`.
Set `SYLLOOM_SITE_PORT` to use another port. The app scenes use fictional examples; they do not open the microphone or load
personal recordings. Fonts and the ocean photographs are self-hosted. The terminal excerpt uses the
actual Markdown renderer with fictional content. Terminal
images are intentionally omitted until real Ghostty captures are supplied.
The build performs no deployment. See `website/credits.html` for image, font and
interface provenance.

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
npm run verify:formatting             # Real formatter, speech fillers, to-dos and protected facts; no clipboard
npm run verify:formatting -- --model path/to/formatter.gguf # Check a candidate without changing settings
npm run benchmark:dictation
npm run benchmark:runtime             # Same selected formatter weights, runtime comparison
npm run benchmark:runtime -- --audio-only # Stopped synthetic audio to formatted text
```

QA uses temporary data directories and fictional samples. German fixtures are
intentional: they exercise Unicode and verify that dictation preserves its language.
Never add real recordings, device exports, model weights, `.env` files or local QA
results to a public source tree. See [AGENTS.md](AGENTS.md) for repository rules.

## License

Sylloom is available under the [MIT License](LICENSE). You can use, modify and
redistribute it, including commercially, as long as you keep the copyright and
license notice. Dependencies, downloaded models, fonts and photographs retain
their own terms. See [NOTICE.md](NOTICE.md) and [website credits](website/credits.html).
