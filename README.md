# Dino Run 3D

A 3-lane endless runner in WebGL (three.js r160). Single self-contained page, no install needed to play.

## Play
Open `dist/index.html` in a modern browser (needs internet once, to load three.js from jsDelivr).

## Controls
- Move: Left/Right or A/D (swipe on touch)
- Jump: Up, W or Space (swipe up, or tap)
- Slide: Down or S (swipe down); in the air it forces a fast fall
- Pause: Esc or P. All keys can be remapped in Settings.

## Develop
    node --test test/*.test.mjs     # 17 logic tests, incl. a 300-seed fairness fuzz
    node build.mjs                  # bundles src/*.js into dist/index.html

Source layout: `src/logic.js` (pure rules, tested), `src/gfx.js` (three.js scene),
`src/audio.js` (procedural music and SFX), `src/main.js` (game loop, input, UI),
`src/index.template.html` (markup and styles).
