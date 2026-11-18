# Motion Tool (Touquet 2027 artist card)

Artist card generator with four layout presets. **Reveal**: two halves of
horizontal rows, each a strip of two-colour stripes, split at the centre
seam and slide open to reveal a photo; the stage name and day sit on the
closed card, the times, artist name and stage unfold as word blocks once
the card is open. **No blocks**, **Block row** (thin strips at the top and
bottom) and **Side blocks** are one-stage posters: the stripes move for the
whole loop and the word blocks are simply there, static. Exports PNG stills and
one-loop H.264 MP4s (2x: 2160 wide, 60 fps, ~0.4 bit per pixel per frame),
with music when an MP3 is loaded.

The UI and the card follow the Figma design in Touquet-2027 (frames 229:94,
232:1464); the label blocks reproduce its metrics exactly (Avantt Bold, -2%
tracking, cap-height trimmed text boxes, 3 px side and 12/24 or 18/18 px
vertical padding at 540 wide, 4.5 px gaps).

## Run

```
npm install
npm run dev      # http://localhost:5173
npm run build    # dist/
```

Avantt Bold and SemiBold are expected in `public/fonts/` (licensed, not in
the repo). `npm run deploy` builds and pushes `dist/` to the `gh-pages`
branch, which GitHub Pages serves at https://typograaf.github.io/artist-card/.
The bundled default photo is `public/default.jpg`.

## Controls

Left column:

- **Format** 4:5, 1:1, 9:16 (1080-based canvases). **Layout preset** the
  examples from the Figma sheet, photo included: 1 Reveal (the two-stage
  construction), 2 Infos Pratiques (side blocks, 24 px units, title at the
  top, sentence at the bottom), 3 Full blocks (the stripes held open
  around the photo, logo at the bottom), 4 App TMB26 (two strip rows at the
  bottom, 36 px each, top colours over bottom colours). A preset resets
  everything but the format and loops; edit from there. The example photos
  live in `public/presets/` (licensed, not in the repo, like the fonts).
- **Title, Day, Time, Artist, Stage, Info** every word becomes its own
  block. Title is a big line for posters without an artist (Infos
  Pratiques Camping, App TMB26); it wraps at the card width and Enter
  starts a new row of blocks. The S / M button next to Info switches the
  sentence between 12 px and 18 px; Enter in Info starts a new block row. The
  day is set in capitals, the stage is big when there is no artist and in
  capitals under the artist name otherwise, the time is one block, the info
  sentence one small block. **+** next to the artist adds a second artist
  (two at most): the B2B badge sits in front of the second name. **Image**
  loads or removes the photo (or drop one on the preview, paste one, or
  click an empty card). **Music** loads an MP3: the strip above the card
  shows the part of the track the loop uses, first bar = where the music
  starts, last bar = where the loop ends; drag the waveform itself (the
  grabbed point sticks to the cursor, left scrubs forward), the readout
  shows the start.
  The MP4 gets the MP3 frames from that point, cut hard at the end, no
  re-encoding. **Logo** (one-stage
  presets only) off, top or bottom, black or white.
- **One-stage posters on the card** the blocks form a centred stack and
  only ever move vertically. Drag a block up or down to reorder it (rows
  snap to the 9 px gap); drag it out above or below the stack to detach it
  at its own height; bring it back near the stack to snap it in again.
  Shift-drag on any block, or anywhere on the stack, moves the whole
  attached collection. Backspace while holding a block clears its text, so
  the row disappears. Order, detached heights and the
  stack height are in the link. Shift while dragging the falloff handle
  snaps it to the centre lines; the handle only shows in the presets that
  have a hole (Reveal, Side blocks, Full blocks).
- **Text time** seconds one label block takes to come in or go (1 s in the
  design, reveal only). **Loop length** (one-stage posters) the stripes'
  motion cycle in seconds. Settings and text fields that cannot change the
  picture in the current preset are hidden, and the two columns rebalance:
  the artist cards (1, 3) take day, time, artist and stage, the info
  posters (2, 4) a title and the sentence; a one-stage poster has no
  opening or holds, the block row has no hole, no blocks means no stripe
  settings at all.
- **Hold closed, Opening time, Opening %, Hold open** the loop is closed
  hold, open, open hold, close, then the seam labels fold back in (every
  label block opens and closes in 1 s, one row stagger apart, on a soft
  easing). Opening % is how far the rows slide apart;
  the edge blocks stay on top of that.
- **Vignette %** how much the hole follows the falloff circle: 0 is two
  vertical lines, 100 the circle. The small handle on the card is the
  falloff centre (default: the middle of the canvas); drag it to move the
  falloff, and while it is selected scroll over the card to resize the
  circle (Escape deselects). **Faith %** 100 follows the falloff, 0 is
  complete chaos: a random width per row and side.
- **Rows top / bottom** row counts; **Strip height** (block row only) the
  height of one strip row in px at 1080.
- **Rows stagger** seconds between rows; **Irregularity %** extra blocks
  left standing per row and side, more towards the outer rows; **Shape
  seed**; **Top / Bottom / Centre** stagger order (closing runs in reverse).

Right column:

- **Block size** the stripe unit in px at 1080 (45 in the reveal, 24 for the
  side blocks). **Block width** widest edge block left in an open row, in units (one unit
  is the card's short side / 24); the edge blocks breathe between that and
  two units less, never resting. **Block travel** largest sideways step of a
  row's pattern in units. **Block seed**.
- **Floaters** number of floating blocks spread over the open rows (0 =
  none), **Floaters size** largest in units (smallest is half), **Floaters
  travel** largest sideways step in px on the 1080 canvas. They show their
  own stripes, grow, shrink to nothing and back, and drift; they trail the
  opening a beat behind the hole edge and are gone once a row is fully open
  (in the side and full layouts the rows are held open, so they simply live
  in them).
- **Colours** the 67 Touquet colourways, locked sets of four (top A / B,
  bottom A / B): the arrows step through them, the box shows the current
  number (type one to jump; `–` means custom colours). Click a swatch for a
  picker, hover it and press Cmd+V to paste a hex (with or without #).
- **Loops** 1x, 2x or 4x: how many times the loop plays in the MP4, so a
  longer piece of the music fits; the timeline and the music strip cover
  that whole length.
- **Copy / Paste settings** the whole state as JSON (values are clamped).
  The URL hash always carries every setting that differs from the defaults
  (photo excepted), so the link itself restores the state.
- **Export MP4 / PNG**.
- **Copy for Figma** the frame shown in the preview, for the Figma plugin
  (see Figma below).

## Figma

`figma-plugin/` is a small Figma plugin that builds a card as native,
editable layers: the photo as an image, every stripe and floater a
rectangle (grouped per row), the logo as vectors, every text block an
auto-layout frame with the tool's padding, fill, font size and tracking
and editable cap-height-trimmed text. The card itself is the auto-layout:
the text stack is its one flowing child, pinned to the top or bottom edge
and centred, so edits re-flow and stay centred; everything else is
absolute. Only the frame shown in the preview is taken (set
the time first). The text is set in Avantt Bold, which has to be installed
on that machine (Inter Bold stands in otherwise, with a note).

Install once: Figma desktop, Plugins > Development > Import plugin from
manifest, pick `figma-plugin/manifest.json`. Then either

- run the plugin: it opens the live tool in its window; set the card up and
  press **Send to Figma**; or
- press **Copy for Figma** in the tool anywhere (the site, or the code layer
  in the Touquet file), run the plugin and press **Paste from clipboard**.

## Model

Every row's pattern is never still: its stripe width glides between 1, 2
and 3 units and the whole pattern drifts sideways, both as chains of
easy-eased keyframes with random spacing, joined by the opening easing. The
stripe chain starts a transition with the row's opening and returns to the
closed width with its closing; the drift chain runs free and seamless. The
pattern scales about a seeded point away from the seam, so left and right
halves move differently. The edge blocks of an open row have their own
integer chain.

`analysis/` holds the scripts used to measure the original reference video.
