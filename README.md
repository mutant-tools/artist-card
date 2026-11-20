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

The preview is on the left, the settings in one column on the right (it
scrolls when they run past the window). The sliders are rows of ticks:
click or drag, arrow keys step, and the label shows the value while the
pointer is over the row.

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
  picture in the current preset are hidden: the artist cards (1, 3) take day, time, artist and stage, the info
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
  in them). **Image floaters**, **size** and **travel** are the same kind of
  block inside the photo or video: a slice of it pushed sideways (by up to
  the travel; the floater itself drifts half that), under the stripes and
  the block floaters, so the picture itself tears and moves. Exports carry
  them in the photo.
- **Colours** the 67 Touquet colourways, locked sets of four (top A / B,
  bottom A / B): the arrows step through them, the box shows the current
  number (type one to jump; `–` means custom colours). The fifth swatch
  is the design's yellow. A click on any of the five makes it the colour
  behind the words (the text turns black or white, whichever has the
  better contrast on it); a double click opens a picker, Alt-click copies
  the hex, hover a swatch and press Cmd+V to paste a hex (with or without
  #).
- **Image** a photo or a video, loaded or dropped on the preview. A video
  (MP4, MOV or WebM; H.264, HEVC, VP9, AV1, ProRes, any size, any frame
  rate) is converted once on import into a uniform in-memory clip (H.264,
  at most 2160 px on the long side and 60 fps, a key frame every half
  second; the Load button shows the progress) and from then on the tool
  decodes the frames itself with WebCodecs, driven by the timeline, so
  playback runs at the clip's own frame rate with nothing for the browser
  to throttle or skip. A source the browser's WebCodecs cannot decode
  (ProRes in Safari, for instance) is stepped through a video element
  instead, at 30 fps. The piece used is as long as the export (a shorter
  video loops), and the stepper that appears between Load and Remove sets
  where in the video it starts, in seconds, wrapping round the end. Exports
  read the same frames. **Remove** leaves the card without a background.
- **Logo** off, top or bottom, white or black, in every layout; **Lockup**
  the Basic, 10 Years or Full version. At the bottom each lockup keeps its
  own ink at the margin; at the top the wordmark stays put when the lockup
  changes (the Full one is placed at the margin and the others put their
  wordmark on its wordmark).
- **Artist** Enter in the name fields puts the rest of the name on a new row
  of blocks (the second artist keeps the B2B badge on its first row).
- **Loops** 1x, 2x or 4x: how many times the loop plays in the MP4, so a
  longer piece of the music fits; the timeline and the music strip cover
  that whole length.
- The URL hash always carries every setting that differs from the defaults
  (photo excepted), so the link itself restores the state.
- **Export MP4 / PNG** at the card's size: 1080x1080, 1080x1350,
  or 1080x1920. Without a photo the PNG is transparent.
- **Export Figma** the frame shown in the preview, for the Figma plugin
  (see Figma below).
- **Undo / redo** Cmd+Z and Cmd+Shift+Z step through every setting change
  (a slider drag or a typed word is one step); photos, video and music are
  not part of the history. Inside a text field Cmd+Z is the field's own undo.
- **Shortcuts** the ? in the bottom-right corner of the preview lists them
  (hover, click or press ?): Space plays, arrows step frames (Shift: ten),
  Home/End jump, Up/Down change the colourway, 1-4 pick a preset, F cycles
  the format, L the logo position, Cmd+S / Cmd+O save and open a .touquet,
  Cmd+I loads a photo or video, Cmd+E exports the MP4, Cmd+Shift+E the PNG.
- **Export InDesign / Illustrator** the frame shown in the preview as an
  InDesign or Illustrator file (see below).
- **Save** and **Load**: everything in one `.touquet` file (settings, the
  photo or video, the music, with their start points). Save opens the
  browser's own save dialog where there is one (Chrome, Edge); elsewhere it
  asks for a name and downloads. A `.touquet` can also be dropped on the
  preview.
- The timeline: in the reveal, the ticks of the resolved state (everything
  in, nothing leaving yet) are tinted and its two ends darker; Shift-drag
  on the timeline snaps to those two keyframes.

## Figma

`figma-plugin/` is a small Figma plugin that builds a card as native,
editable layers: the photo as an image, every stripe and floater a
rectangle (grouped per row), the logo as vectors, every text block an
auto-layout frame with the tool's padding, fill, font size and tracking
and editable cap-height-trimmed text, the stack one hugging auto-layout
frame that is free to move (edits re-flow inside it: rows stay centred
on the stack, the stack grows from its left edge). Only the frame shown in the preview is taken (set
the time first). The text is set in Avantt Bold, which has to be installed
on that machine (Inter Bold stands in otherwise, with a note).

Install once: Figma desktop, Plugins > Development > Import plugin from
manifest, pick `figma-plugin/manifest.json`. Then either

- run the plugin: it opens the live tool in its window; set the card up and
  press **Send to Figma**; or
- press **Export Figma** in the tool anywhere (the site, or the code layer
  in the Touquet file), run the plugin and press **Paste from clipboard**.


## InDesign

**Export InDesign** downloads a zip with a `.idml` (InDesign's open XML
format, built on the TMB artist template's resources) and a `Links` folder
holding the photo. Open the `.idml` in InDesign: the photo is a placed
image, every stripe and floater a rectangle with its own swatch (grouped
per row), the logo vector paths, every word its own text frame in Avantt
Bold with the tracking. The block behind a word is paragraph shading
measured from the baseline (cap height plus the padding up, padding down),
and the frame auto-sizes, so the block follows the text when it is edited.
Like InDesign itself, the other words in a row do not slide along. The
document has a 3 mm bleed (as if the short side were an A4 width: 15 px at
1080), into which the photo and the strips on the edges extend. Only the
frame shown in the preview is taken (set the time first). Avantt must be
installed.

## Illustrator

**Export Illustrator** downloads an SVG that Illustrator opens with the
artboard as the card and the same bleed around it: the photo embedded,
every stripe and floater a rectangle (grouped per row), the logo as paths,
every word a text object in Avantt Bold with the tracking and a rectangle
behind it. Illustrator has no text-following block, so there the block
is a plain rectangle.

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
