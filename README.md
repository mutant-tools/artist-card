# Motion Tool (Touquet 2027 artist card)

Artist card generator with four layout presets. **Reveal**: two halves of
horizontal rows, each a strip of two-colour stripes, split at the centre
seam and slide open to reveal a photo; the stage name and day sit on the
closed card, the times, artist name and stage unfold as word blocks once
the card is open. **No blocks**, **Block row** (thin strips at the top and
bottom) and **Side blocks** are one-stage posters: the stripes move for the
whole loop, the word blocks slide in once and stay. Exports PNG stills and
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

- **Format** 4:5, 1:1, 16:9, 9:16 (1080-based canvases). **Layout preset**
  1 Reveal, 2 No blocks, 3 Block row, 4 Side blocks; a preset sets the row
  counts and block width the design uses (Side blocks: 24 px units, block
  width 3; Block row: strips of 36 px, Rows top / bottom = strips, 0 allowed).
- **Day, Time, Artist, Stage, Info** every word becomes its own block. The
  day is set in capitals, the stage is big when there is no artist and in
  capitals under the artist name otherwise, the time is one block, the info
  sentence one small block. **+** next to the artist adds a second artist
  (two at most): the B2B badge sits in front of the second name. **Image**
  loads or removes the photo (or drop one on the preview, paste one, or
  click an empty card). **Music** loads an MP3: the strip above the card is
  the whole track, the dark part the loop; drag it to set where the music
  starts (the readout shows the start). The MP4 gets the MP3 frames from
  that point, cut hard at the end, no re-encoding. **Logo** (one-stage
  presets only) off, top or bottom, black or white.
- **One-stage posters on the card** the blocks form a centred stack. Drag a
  block up or down to reorder it (rows snap to the 9 px gap); drag it
  sideways or out of the stack to detach it and drop it anywhere; bring it
  back near the stack to snap it in again. Shift-drag moves the whole stack.
  Order, detached positions and the stack height are in the link.
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
- **Rows top / bottom** row counts.
- **Rows stagger** seconds between rows; **Irregularity %** extra blocks
  left standing per row and side, more towards the outer rows; **Shape
  seed**; **Top / Bottom / Centre** stagger order (closing runs in reverse).

Right column:

- **Block width** widest edge block left in an open row, in units (one unit
  is the card's short side / 24); the edge blocks breathe between that and
  two units less, never resting. **Block travel** largest sideways step of a
  row's pattern in units. **Block seed**.
- **Floaters** number of floating blocks spread over the open rows (0 =
  none), **Floaters size** largest in units (smallest is half), **Floaters
  travel** largest sideways step in px on the 1080 canvas. They show their
  own stripes, grow, shrink to nothing and back, and drift; they trail the
  opening a beat behind the hole edge and are gone once a row is fully open.
- **Colours** the 67 Touquet colourways, locked sets of four (top A / B,
  bottom A / B): the arrows step through them, the box shows the current
  number (type one to jump; `–` means custom colours). Click a swatch for a
  picker, hover it and press Cmd+V to paste a hex (with or without #).
- **Copy / Paste settings** the whole state as JSON (values are clamped).
  The URL hash always carries every setting that differs from the defaults
  (photo excepted), so the link itself restores the state.
- **Export MP4 / PNG**.

Preview:

- Drag the artist block group up or down to place it (vertical only, saved
  in the settings as `labelY`).
- Drag the photo to reposition it; scroll over the card to zoom it about the
  pointer; scroll outside the card to resize the preview.
- The timeline under the card: click the frame number or press Space to
  play / pause, drag the ticks to scrub, arrow keys step one frame (Shift:
  ten), Home restarts.

Hidden defaults (no UI, set via paste settings): `focus` (which half starts
with 3-unit stripes, default bottom), `moveMin` / `moveMax` (1.8 / 3.6 s
block keyframe spacing), `floatMoveMin` / `floatMoveMax` (1 / 2.5 s), the
easing `cubic-bezier(0.70, 0.10, 0.10, 0.90)` measured on the reference.

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
