# Decisions

Why Movie Sound works the way it does. Newest first.

## Following the Tidal extension's EQ live (19 Oct 2026)

Before this, the bridge used a saved copy of the extension's presets (`bridge/chrome-settings.js`, written by `tools/import-chrome-audio-settings.mjs`). It always started on the same preset, and it never saw later edits. The goal was to have Movie Sound play whatever the extension is set to, live, without adding much that could break ("I don't want to introduce exponential complexity to this, for resilience and reliability purposes").

**Three ways were considered.** Route A was chosen. B and C are written down here in case this changes later ("note what we talked about for other possible options, in case I want to change something about this in the future").

| | How Movie Sound learns the current EQ | For | Against |
|---|---|---|---|
| **A (chosen)** | A small separate script in the Tidal extension (`movie-sound-link.js`) runs only on the bridge page, at `http://127.0.0.1:8791`. It hands the page the extension's saved settings when the page opens, and again each time they change. | Instant. Fewest moving parts. Uses Chrome's own storage API, so a Chrome update can't break it by changing its file format. | Adds code to the Tidal extension (it needed release 1.5.7). That was the main objection: "I wanted to keep movie-sound out of the tidal extension, but fine". So everything for Movie Sound lives in that one file, and the rest of the extension is untouched. Removing the file and its manifest entry undoes it. |
| B | The bridge server reads Chrome's saved settings file every 3 seconds. That's LevelDB, under `Local Extension Settings/<extension id>`, read through a temporary copy. | No change to the Tidal extension. | It depends on Chrome's internal file format. A review (GPT-6.1-Sol) found that a safe reader needs much more: it must follow LevelDB's MANIFEST and CURRENT files (or old values can come back after a compaction), check the copy didn't change while being read, and check every block's checksum. It also needs a new server endpoint with Host-header checks. Cost was never the problem: measured on 19 Oct, checking the file's size and date took about 7 µs, and a full copy and read about 9 ms. |
| C | Read the settings once, each time Movie Sound starts, plus a "Re-read" button. | Simplest. | An edit only takes effect after a restart or a click. |

**Rules that hold for any route:**
- **Unsaved slider moves are followed.** The extension stores the current sliders (`currentParams`) on every move, so Movie Sound doesn't need the preset to be saved.
- **The extension's AUDIO EQ on/off switch is not followed.** That switch turns the EQ on or off for a Chrome tab. If you watch a film in Chrome with Movie Sound on, the sound is processed twice, and turning the extension's EQ off fixes that. If Movie Sound copied the switch, the film would end up with no EQ at all.
- **The "Flat (Bypass)" preset is followed.** Choosing it is a preset choice like any other.
- **While following, the bridge page's preset and dynamics menus are locked** and just show Chrome's settings. Untick **Follow Chrome** to pick by hand. Unticking keeps the sound as it is until you pick; ticking again plays Chrome's latest settings.
- **Pitch is always off while following.** The extension locks pitch off for video itself (its movie mode, 1.5.6), and a key shift would delay the sound against the picture.
- **The sound comes only from Chrome's current settings while following,** never from looking up a preset by name. Settings that arrive while Movie Sound is starting are applied before it goes live, and changes glide over 30 ms (EQ) or 20 ms (switches) instead of jumping.
- **After the extension is reloaded or updated,** the page says the link is lost and keeps the sound. Reload the page (turn Movie Sound off and on) when you're not watching to reconnect.
- **Anything unreadable or out of range is ignored,** and the sound playing stays as it is. Preset names are treated as plain data: a preset called `constructor`, or one called "Chrome's current settings", can't confuse the menu.
- **Without the extension** (missing, turned off, or older than 1.5.7), the bridge uses the saved copy in `bridge/chrome-settings.js`, as before.

**Reviews:** Claude Fable 5.1 and GPT-6.1-Sol reviewed the design before any code (both: go, with changes). Their fixes are the single source of truth while following, the reconcile at start, checking values before converting them, and the glides. `tests/follow-chrome.mjs` holds one regression for each.

**To switch to B or C later:**
- **B:** follow the reader requirements above, and keep the "rules that hold for any route" unchanged.
- **C:** have the bridge request settings only on Start, or on a button press.

The bridge's message handling doesn't care where the settings come from.

## Orion dropped; tools kept (19 Oct 2026)
The setup began in Orion, a WebKit browser that runs Chrome extensions. AMC+ won't stream in Orion, so films now play in Safari, and the Stream Quality HUD covers Safari through a userscript. The Orion tools stay in `orion/` in case they're needed again. Their checks run only on request, because they read your Chrome profile.

## Published (19 Oct 2026)
This repo was moved out of a scratch folder and published. These parts are public on purpose:
- the presets in `bridge/chrome-settings.js`;
- the *Mother of Flies* loudness readings in `measurements/`.

Settings from your other extensions stay out: `orion/extracted-settings.json` and `orion/staged-extensions/` are in `.gitignore`. So are the Orion checks that compare against those settings (`*.local.mjs`). The staging tool reads your subtitle fonts from your settings instead of naming them. Hard-coded home-folder paths became `$HOME` or `os.homedir()`. The live copy moved from a cache folder to `~/Library/Application Support/movie-sound/`, so a cache clean-up can't delete it.

## The double-click app (18 Oct 2026)
- **No Terminal.** Movie Sound.app is an AppleScript wrapper around `bin/movie-audio`.
- **It presses Start for you.** Chrome won't play a page's sound until someone interacts with the page, so the app presses Return on the page's focused Start button (this needs Accessibility permission). Then it hides Chrome, so you're back in Safari.
- **Rebuild it only when its source changes.** Rebuilding re-signs the app, and macOS then forgets its Accessibility permission. `tools/install.sh` updates everything except the app.

## The bridge (18 Oct 2026)
- **After the browser, not in the page.** Protected video can't be tapped in the page (`createMediaElementSource` silences it). Instead, the browser plays to BlackHole 2ch, and a Chrome page captures that with `getUserMedia`.
- **The same sound as the Tidal extension.** The bridge's EQ, leveler, limiter and ceiling are copied from the extension, and its two worklets are byte copies. A test checks that they still match.
- **Output pinned to the DAC's own ID** with `setSinkId`. The system "default" alias (and "communications", or a blank ID) can be switched to BlackHole by macOS, which would feed the sound back into itself. So the bridge refuses those aliases and refuses any BlackHole output.
- **Microphones stay closed.** Input is BlackHole 2ch only, picked by its exact ID rather than Chrome's "Default" alias, which follows the Mac's input setting. A real microphone needs a deliberate override tick.
- **It stops if the DAC disappears.** The film then goes silent instead of moving to other speakers with the EQ still on.
- **The server is local and minimal.** It listens on 127.0.0.1 only, serves its own folder only, answers only GET and HEAD, and returns 400 for malformed paths.
- **Start and Stop are race-safe.** A run counter means a Stop cancels a Start that is still waiting for permission, and a stale Start can't undo a newer one.
