# Session handoff

## State (19 Oct 2026)
- In daily use for films in Safari: BlackHole 2ch → the bridge page in Chrome → iFi Pro iDSD at 96 kHz.
- **New in this repo: Follow Chrome.** The bridge plays the Tidal extension's EQ live. It needs the extension's `movie-sound-link.js` (release 1.5.7). Without it, the bridge uses the saved presets in `bridge/chrome-settings.js`, as before.
- **Tests:** `npm test` (all silent, in Node). `tests/follow-chrome.mjs` is 13/13. The Orion checks are opt-in (`MOVIE_SOUND_LIVE_CHECKS=1`).
- **The live copy** runs from `~/Library/Application Support/movie-sound/bridge`, installed by `tools/install.sh`, with `~/.local/bin/movie-audio`. Before the move it ran from a scratch cache folder.

## How to change it
1. Edit `bridge/` (keep `bridge.js` free of imports: the tests load it as a plain script).
2. Run `npm test`.
3. Run `tools/install.sh`, then turn Movie Sound off and on to load the new page. Don't do this while a film is playing: it means a few seconds of silence.
4. Rebuild the app (`app/build.sh`) only if `app/Movie Sound.applescript` changed. Rebuilding makes macOS forget its Accessibility permission, so it has to be allowed again.
5. **If the presets change shape** in the Tidal extension (new fields or new slider ranges), update:
   - `CHROME_PARAM_RANGES`, `validChromeParams` and `chromeEffectiveParams` in `bridge/bridge.js`;
   - the extension's `movie-sound-link.js`, if the stored keys change.

## History
- **18 Oct 2026:**
  - The bridge, `movie-audio` and the Movie Sound app were built, with three review rounds (GPT-6.1-Sol, GPT-6-Astra, Claude Fable 5.1).
  - The *Mother of Flies* readings checked the EQ boost and the limiter.
- **19 Oct 2026:**
  - Published as its own repo; the Orion tools were moved into `orion/`.
  - Follow Chrome was added (route A in [DECISIONS.md](DECISIONS.md)).
  - The server returns 400 for malformed paths, instead of crashing on them.
