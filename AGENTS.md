# Sylloom

TypeScript, Node.js 22.18 or later. Native audio through flexaudio; no Python runtime.
This directory can also live inside a larger workspace. Do not create nested Git
repositories or change parent-workspace remotes.

- Run `npm run check`, `npm test`, `npm run build` and `npm run release:check` before finishing changes.
- Keep the agreed development version in package.json as the single source for
  CLI and header. Change it when a release/version change is requested and
  synchronize the root package-lock versions. Routine fixes keep that version.
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
- The dictation shortcut authorizes microphone capture, local transcription,
  formatting and insertion into the editable input focused when capture stops.
  Recheck focus and selection before insertion; otherwise copy to the clipboard.
  Never press Enter or send text. History retries only copy, never insert.
- Keep every dictation, including canceled, failed and interrupted captures.
  Only an explicit delete action removes dictation audio or text.
- Insights stay local. Sharing opens a reviewed X draft with aggregate counts only;
  never include transcript text, app context or automatically publish a post.
- Audio is transcribed only after capture stops.
- Global shortcuts use macOS Carbon or Windows RegisterHotKey through Koffi.
  Single modifier keys query only their configured native key state. Do not log
  unrelated keys. Push-to-Talk release during startup must still finish capture.
- Windows targets Windows 11 x64 on CPU. Keep native DLL loading lazy and isolated
  from macOS. Windows setup is per-user and must not require admin access.
- Dictation uses a compact waveform bubble with the liquid entry/exit of call
  popups; preserve focus and click-through. Meeting capture adds a status dot
  and hover/click pause/resume without activation. Do not duplicate routine
  capture states in desktop notices. Respect Reduce Motion. New processing
  animation stays in preview until the user's visual approval.
- Public source archives use the allowlist in scripts/release.ts. Never archive
  the entire workspace or include local state, binaries, model files or Git history.
- The project uses the MIT License in LICENSE. Keep it in source archives and
  packages; preserve Velora attribution and third-party license notices.
- Do not commit, push, publish or deploy without an explicit request. Preserve
  existing changes from other tools or contributors.
