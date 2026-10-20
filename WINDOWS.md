# Windows 11 x64

Windows support is beta. It uses the same terminal interface, models, formatter,
history and recording workflow as macOS. There is no Python runtime or browser
extension. Native bridges are TypeScript and Koffi; PowerShell is used only for
installation, the user PATH and classic Outlook's local COM interface.

## Implemented backends

| Feature | Windows implementation |
| --- | --- |
| Microphone and system audio | flexaudio WASAPI microphone and loopback streams |
| Device changes | Two-second inventory polling, stream switching and default-device fallback |
| Global shortcuts | RegisterHotKey, Ctrl+Alt+Space / Esc / C; no keyboard hook |
| Text insertion | UI Automation focus, text and selection checks, then Ctrl+V and content confirmation |
| Clipboard | Unicode text; preserve prior formats after confirmed insertion; respect newer clipboard changes |
| Waveform and call popup | Nonactivating GDI+ layered windows, bottom center, liquid animation and Reduce Motion |
| Call prompts | Supported native Teams, WhatsApp and Phone Link controls; local Teams API when configured |
| Upcoming Teams reminders | Running classic Outlook default calendar or an explicitly selected local ICS file |
| Teams credential | Windows Credential Manager for the current user |
| Recording controller | Kernel file lock and data-directory-specific named pipe |
| Global command | Per-user `.cmd` launcher bound to the installed Node executable |
| Documents and exports | Shared Markdown renderer, local HTML viewer, native default file/URL handler |

## Verification

Required checks run on macOS and Windows in GitHub Actions. The Windows job also
parses the installer with Windows PowerShell, installs and starts official CPU
runtime bundles without downloading models, checks the command launcher, and
loads the native audio backend without starting a recording.

The opt-in native test creates its own synthetic text window and exercises UI
Automation, Unicode clipboard transactions, shortcut registration and popup/HUD
creation. It checks selection replacement and rejects changed focus or content.
The UI test explicitly skips if the runner has no visible window station; its
insertion check also skips without a foreground desktop. Audio backend loading
is checked separately without capture. Tests do not open the microphone or
inspect real application content.
Run it only on an idle test desktop; it briefly takes focus and uses the clipboard:

```powershell
$env:SYLLOOM_TEST_WINDOWS = '1'
npx tsx --test test/windows-native.test.ts
Remove-Item Env:SYLLOOM_TEST_WINDOWS
```

CI and passing unit tests are not evidence of successful recording on a physical
Windows device. Complete these checks before relying on it for a work meeting:

1. Run `sylloom doctor`. Check both audio sources, runtime availability and models.
2. In a scratch document in Notepad, dictate a short German/English message and a
   mixed introduction, to-do list and follow-up paragraph. Confirm the formatted
   text appears without sending anything. Repeat in the actual work input.
3. While processing, change the focused app, selection or existing text. Confirm
   Sylloom leaves that input alone, saves the result and offers Ctrl+V instead.
4. Record a short fictional meeting with microphone and system playback. Switch
   the input and output devices, unplug one, pause/resume and mute each track.
   Stop, name it, explicitly choose a transcript action and read/export the note.
5. Test ringing, accepted calls, Teams prejoin, real hangup and a detector outage
   separately in each supported call app. Unknown signals must not stop capture.
6. Connect running classic Outlook, check a recurring Teams appointment and its
   reminder, then disconnect it. Check local ICS separately for New Outlook.
7. Exit and start again from a different directory. Check history, recovery and
   single-controller exclusion, including after an interrupted process.

## Limits

- Supported app controls vary by app version and language. Browser calls and
  hidden/inaccessible providers are not guaranteed. Call observation never starts
  a recording automatically; missing hangup proof requires a manual stop.
- UI Automation and Windows input injection cannot access every custom or
  elevated control. Clipboard fallback is intentional in those cases.
- The Windows popup is a mouse-operated, nonactivating native surface. Terminal
  controls remain available for keyboard operation.
- New Outlook has no classic Outlook COM calendar interface. No Graph login or
  extension is installed as a substitute; select a local ICS file instead.
- Windows ARM64, x86, Linux, GPU acceleration and guaranteed gapless switching
  are outside this first Windows target. Models and audio may compete for CPU and
  memory. No Windows performance measurements are claimed from Mac benchmarks.
