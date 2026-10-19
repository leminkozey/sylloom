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
The product mark is white in the SVG, terminal header, Insights and share card.
No remote fonts or upstream brand images are required.

## Documents and dictation indicator

The Markdown renderer uses `marked` with terminal colors for headings, lists,
tables, quotes and code. Reading starts at the document beginning. HTML exports
are independent local files with system fonts, dark/light color schemes and print CSS.

The dictation indicator is a dark 122 × 38 point AppKit bubble driven from
TypeScript through Koffi, with a 48-point transparent margin for its liquid outline
and shadow. It displays only a 13-bar waveform, takes no focus and passes clicks
through during every phase, including transitions. Microphone levels drive
recording feedback. Gray indicates processing and green confirms delivery.
Reduce Motion uses a short fade and disables the processing wave animation.
The indicator’s waveform is a functional recording display, separate from the
static product mark. `sylloom preview-indicator` plays one simulated dictation
without opening the microphone.

See [NOTICE.md](NOTICE.md) for attribution and the unresolved project license.

## Library and activity references

The Library uses searchable type filters, pinned results, original-speech previews
and explicit recovery states. Insights uses a Monday-first contribution grid,
spoken-word totals, weighted recording-based WPM and current/longest streaks.
The browser snapshot and share card use Sylloom's existing mark and violet palette,
system fonts and no external scripts, fonts, analytics or requests.

Interaction references, independently implemented:

- [Wispr Flow insertion and clipboard recovery](https://docs.wisprflow.ai/articles/7971211038-fix-text-not-pasting-after-dictation).
- [Wispr Flow usage and Insights](https://docs.wisprflow.ai/articles/8760230576-your-usage-tab-track-your-dictation-stats-in-wispr-flow).
- [Wispr Flow failed-transcription recovery](https://docs.wisprflow.ai/articles/2503460374-Retry-failed-transcriptions).
- [GitHub contribution activity](https://docs.github.com/en/account-and-profile/concepts/contributions-on-your-profile).
- [X's share-button generator](https://publish.x.com/), which generates the `x.com/intent/tweet` composer endpoint.

Sharing requires a visible draft review. Only aggregate activity and the public
project link enter the draft. Posting remains an explicit action in X.

## Planned quality-of-life improvements

Recorded product ideas, deferred until the current recording, dictation and
recovery paths are hardened. They are not implemented or scheduled for this pass.
Wording, corrections, snippets and profiles must stay in private local data.

| Priority | Improvement | Benefit and completion check |
| --- | --- | --- |
| 1 | Personal dictionary and explicit correction rules | Keep names and technical terms accurate; let the user save a recurring correction as a local rule. Preserve the original transcript and allow rules to be edited or removed. |
| 1 | Spoken snippets | Expand a distinctive phrase such as "my signature" into text the user saved. Preserve paragraphs; never send a message or run commands. |
| 2 | Per-app formatting profiles | Remember a user-selected style for mail, chat or an editor. Keep the global default as fallback and avoid reading unrelated app content. |
| 2 | Audio playback at transcript timestamps | Select a source sentence and play its matching audio locally from the Library. A missing WAV must not prevent reading the note. |

The copy-latest shortcut, separate retranscription/reformatting, stage timings,
date/state filters, live Library refresh and storage/recovery overview already
exist and are not future roadmap items.

Dictionary and snippet interaction references:
[Flow dictionary](https://docs.wisprflow.ai/articles/4052411709-Teach-Flow-your-words-with-the-dictionary),
[Flow snippets](https://docs.wisprflow.ai/articles/5784437944-create-and-use-snippets).

Wispr Flow's [recovery workflow](https://docs.wisprflow.ai/articles/2503460374-Retry-failed-transcriptions)
and [copy/paste recovery controls](https://docs.wisprflow.ai/articles/7971211038-fix-text-not-pasting-after-dictation)
are interaction references. Sylloom keeps its offline processing and explicit
deletion rules.

## Local Outlook reminders and call bridge

The bridge runs with the CLI. It reads local app APIs and uses the existing
recorder, global storage lock and pending-recording workflow. No Outlook add-in,
Teams extension, browser extension, Graph connection, additional login or hosted
backend is involved. There is no calendar screen or browser controller.

### Meeting reminders

Settings / Outlook meeting reminders controls reminders and their 1–60 minute
lead time (default: five). Connect local Outlook explicitly. Enabled local
sources refresh every minute; due reminders are checked every 15 seconds. Only
future timed Teams meetings qualify. Teams links are detected in local calendar
metadata, including ICS event descriptions. All-day and past events are ignored.

A compact popup shows the meeting title and lead time. Open Teams is available
when a verified Teams URL exists; it opens only after a click. A reminder never
starts audio or joins a meeting automatically. Hashed occurrence/start keys prevent
repeat reminders across restarts; rescheduled occurrences can remind again.
Stale source data does not trigger reminders. No event content is stored in the
reminder ledger.
Selecting a candidate does not consume it. The bridge rechecks call, capture and
processing state after selection and acknowledges only a successfully displayed
popup. A visible reminder stays in place until dismissed or its meeting starts;
other reminders wait instead of replacing it. Calls and switching reminders Off
close a visible reminder. Failed popup delivery remains retryable.

Local Outlook scripting is a partial provider. A bundled scripting definition is
not proof that the installed Outlook mode exposes its active calendar. In the
local compatibility probe, New Outlook's scripting interface returned zero
unfiltered events and accounts, while its legacy SQLite calendar was also empty.
The active profile instead used the newer HxStore. Sylloom checks the local
New Outlook mode flags when scripting exposes neither accounts nor events and
marks that connection unavailable. Its proprietary cache is unsupported and is
never modified or treated as a complete calendar. Background reminders cannot
work from an empty legacy profile. An existing macOS calendar or local ICS file is an optional fallback,
never a reason to add another account silently.

EventKit access is requested only through the explicit connection action. See
Apple's [calendar access documentation](https://developer.apple.com/documentation/technotes/tn3152-migrating-to-the-latest-calendar-access-levels).
No adapter writes to Outlook, its profile or the user's original calendars.

### Calls and recording

The Teams [third-party app API](https://support.microsoft.com/en-us/teams/calls-devices/connect-to-third-party-devices-in-microsoft-teams)
is observed over a loopback-only WebSocket. The protocol follows the
[Teams Monitor implementation](https://github.com/svrooij/teams-monitor).
Organization policy and client settings can disable this interface. Tokens are
entered through a masked CLI field and stored in macOS Keychain. Sylloom never
sends a reaction to force pairing and never sends call-control commands.

A separate worker observes call buttons in the enabled FaceTime/Phone, native
WhatsApp and Teams processes, with bounded traversals. It skips text inputs and
reads no unrelated notifications, chat or mail bodies or keyboard input. It also
reads the public Core Audio process-list, bundle-ID and input/output activity
properties. Only these apps' streams are considered; it never opens an audio
stream during observation. Output activity alone, such as a ringtone, cannot
prove a call. Duplex audio offers an explicitly labeled Audio session detected
prompt, since call state and ringing are not guaranteed by these flags.

CallKit's observer is not supported for native macOS in the installed SDK.
Runtime CallKit and TelephonyUtilities probes exposed no calls during a real
iPhone relay call, so neither is used as a production signal. A real iPhone relay
test verified active audio detection, the popup and the subsequent idle state.
That test showed the popup only after answering. The ringing adapter also checks
Notification Center's buttons while an Apple call panel or Apple output stream is
present. It accepts a single Answer/Annehmen action, includes button help labels,
ignores disabled buttons and keeps each window's actions separate. It reads no
notification body. All matching process instances are inspected. Apple's
single-action banner is also demonstrated in this independent
[FaceTime bridge classifier](https://github.com/kingbootoshi/facetime-bridge/blob/main/native/Sources/FaceTimeBridge/StateClassifier.swift).
This added adapter has not yet been verified with a real ringing call.
Native WhatsApp and Teams remain unverified with their
actual clients. Calls that stay on another device or in WhatsApp Web are not
observable through these native adapters.

Confirmed ringing or active state offers Record / Dismiss. The native AppKit popup is 330 × 104 points,
bottom-center on the pointer's display, with the actual logo and centered buttons.
It takes no keyboard focus before a click. Dictation uses a compact waveform bubble.

The shared `src/native/liquid-bubble.ts` transition morphs a separate CAShapeLayer
through a circle, a pointed droplet,
a stretched blob, a wide overshoot and the final rounded card. Each silhouette
uses eight matching cubic Bezier segments, so Core Animation interpolates the
actual outline. All shapes share the same horizontal center. The seed starts at
the bottom of the display and rises into the card over 420 ms. Dismissal gathers
the card downward into a droplet over 280 ms. A short edge highlight keeps the
small silhouette visible. The shadow belongs to the animated shape.

The native controls retain fixed 330 × 104 bounds on a separate layer. They appear
after the outline has opened and disappear before it contracts, avoiding warped
or clipped text. A 48-point transparent margin contains the outline and shadow.
Layout is completed before revealing the first frame. Reduced Motion uses only a
150 ms fade. Interrupted transitions resume from the presentation path and
opacity, with old completion timers canceled. Closing releases retained paths,
colors, timers and native objects. `sylloom preview-popups` plays three preview
scenes without audio capture or call detection; closing the preview allows the
exit morph to finish. The dictation bubble uses the same timing and outline stages,
adapted to its pill dimensions. Its exit finishes even after waveform updates stop;
starting again during dismissal reverses the transition without a stale hide timer.

The state machine distinguishes unknown, idle, ringing and active. Repeated
updates and brief observer outages do not create a new call. Identities are unique
across apps within a detector. An app's idle state cannot stop another app's capture.
Accessibility-only idle requires three complete observations of a responsive app.
For Apple's separate call panel, a panel observed during that call must disappear
and both audio streams must be inactive for three samples; navigation in the main
Phone/FaceTime window is not proof of hangup while the panel is present. Audio
ending alone cannot prove hangup. A confirmed idle transition must remain stable
for 1.5 seconds before automatically stopping a capture associated with that call
and detector instance. Unknown/disconnected never stops audio.
Settings can switch automatic stop Off. Manual recordings without a call identity
are unaffected. State-machine and capture behavior are also covered with
hardware-free regression tests; the live popup test did not record audio.

Only an explicit Record click starts capture. Competing recordings and dictation
are blocked. After stop, naming and transcript retention remain explicit in the
CLI. No reminder, hangup or shutdown selects an LLM action for the user.

### CLI settings

Settings are grouped by purpose. Boolean rows show On / Off and accept Enter,
Space or arrow keys. Dictation, shortcut, recording and reminder preferences are
edited as drafts; Save applies them, Esc discards them. Connection actions state
that they apply immediately. Navigation preserves the selected row. Secrets never
appear in the rendered terminal. Models retain their separate four-purpose setup.
