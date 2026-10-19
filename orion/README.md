# Orion tools (not used)

Movie Sound began in [Orion](https://kagi.com/orion/), a WebKit browser that can run Chrome extensions. AMC+ won't stream in Orion, so films now play in Safari and these tools aren't used. They're kept in case that changes.

- `stage-extensions.mjs` builds Orion-ready copies of two Chrome extensions, Video Speed Controller and HTML5 speed + subtitles. It seeds them with your own settings from `extracted-settings.json`. It writes to `staged-extensions/`, which, like `extracted-settings.json`, stays out of git: both hold your personal settings, and the copies are third-party code.
- `../tools/extract-chrome-settings.mjs` writes `extracted-settings.json` from a read-only copy of Chrome's saved extension settings. It shares its LevelDB reader with the preset importer.
- `content-bridge.template.js` hands those settings to the staged Video Speed Controller.
- To stage: `node tools/extract-chrome-settings.mjs`, then `node orion/stage-extensions.mjs`. Your subtitle fonts are read from your saved settings.
- `tests/live-repros.mjs` runs only with `MOVIE_SOUND_LIVE_CHECKS=1`, after staging, because it reads your Chrome profile.
- The detailed checks of the staged copies compare against your exact settings (key bindings, fonts, flags), so they aren't published. A local, git-ignored copy lives in `tests/personal-checks.local.mjs` on the Mac that made them.

What made Orion work, in case you try again:
- Orion joins an extension's content scripts into one script. So a `"use strict"` at the top of the first file makes every later file strict, and that broke HTML5 speed + subs.
- Orion has no `chrome.fontSettings`.
- The colour-matrix "paint" setting flattens HDR, so it's off in the staged copy.
