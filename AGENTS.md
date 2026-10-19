# Sylloom

TypeScript, Node.js 22.18 or later. Native audio through flexaudio; no Python runtime.
This directory can also live inside a larger workspace. Do not create nested Git
repositories or change parent-workspace remotes.

- Run `npm run check`, `npm test`, `npm run build` and `npm run release:check` before finishing changes.
- Product UI, errors, documentation and generated meeting notes are English.
  Preserve the language of dictated messages and original source quotations.
- Recordings, transcripts, model weights, settings and QA output belong only in
  ignored `data/` or the configured `SYLLOOM_HOME` directory.
- Never hardcode a developer’s name, account, email, home path or audio device.
  Use fictional test data and runtime device discovery.
- Keep the Velora CLI attribution in README.md, DESIGN.md, NOTICE.md and adapted source.
  Sylloom’s waveform mark is independent of upstream branding.
- A stopped meeting remains pending until named and given an explicit transcript
  decision. Closing, crashing or canceling must not choose an action for the user.
- The dictation shortcut explicitly authorizes microphone capture, local
  transcription, formatting and clipboard copy for that dictation. Never auto-paste
  or send text. Audio is transcribed only after capture stops.
- Global shortcuts use macOS Carbon through Koffi. Do not log unrelated keys.
- The floating indicator shows only a waveform. No labels, buttons, timer or
  background surface; preserve keyboard focus and click-through behavior.
- Public source archives use the allowlist in scripts/release.ts. Never archive
  the entire workspace or include local state, binaries, model files or Git history.
- The project license remains undecided. Do not add or imply an open-source grant.
- Do not commit, push, publish or deploy without an explicit request. Preserve
  existing changes from other tools or contributors.
