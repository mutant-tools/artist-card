// Artist Card plugin: rebuilds a card from the tool's "Send to Figma" /
// "Copy for Figma" description as native, editable layers.
//
// Card (auto-layout: its one flowing child is the text stack, pinned to the
//       top or bottom edge and centred, so edits re-flow)
//   Photo            image fill, absolute
//   Strips           absolute; one group of rectangles per row, plus Floaters
//   Logo             vectors, absolute
//   Text             vertical auto-layout, centred
//     <row>          horizontal auto-layout
//       <word>       auto-layout with the padding, filled; editable text
//   <free rows>      card-wide hug-height wrapper, absolute at its height

figma.showUI(__html__, { width: 1440, height: 900, themeColors: true });

const say = (text) => figma.ui.postMessage({ type: "status", text });

figma.ui.onmessage = async (msg) => {
  if (!msg || msg.type !== "build") return;
  try {
    const node = await build(msg.spec);
    figma.currentPage.selection = [node];
    figma.viewport.scrollAndZoomIntoView([node]);
    say("Done: " + node.name);
    figma.notify("Artist card built: " + node.name);
  } catch (err) {
    console.error(err);
    say("Failed: " + (err && err.message ? err.message : err));
    figma.notify("Artist card failed: " + (err && err.message ? err.message : err), { error: true });
  }
};

function hex(c) {
  const n = parseInt(c.replace("#", ""), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

function base64Bytes(dataUrl) {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return figma.base64Decode(b64);
}

async function pickFont(want) {
  const family = want.family || "Avantt";
  const styles = [want.style || "Bold", "Bold", "Semibold", "SemiBold", "Heavy", "Black", "Medium", "Regular"];
  for (const style of styles) {
    try {
      await figma.loadFontAsync({ family, style });
      return { family, style };
    } catch (e) {
      // try the next style
    }
  }
  await figma.loadFontAsync({ family: "Inter", style: "Bold" });
  figma.notify(family + " is not installed here: the text is set in Inter Bold", { timeout: 5000 });
  return { family: "Inter", style: "Bold" };
}

async function build(spec) {
  if (!spec || spec.v !== 1) throw new Error("unknown description");
  const font = await pickFont(spec.font || {});
  const W = spec.w;
  const H = spec.h;
  const gap = spec.gap;
  const bgFill = hex(spec.colors.bg);
  const textFill = hex(spec.colors.text);
  const stack = spec.stack;
  const anchor = stack ? stack.anchor : "top";

  // the card: an auto-layout frame whose flowing child is the text stack
  const card = figma.createFrame();
  card.name = spec.name || "Artist card";
  card.layoutMode = "VERTICAL";
  card.resize(W, H);
  card.primaryAxisSizingMode = "FIXED";
  card.counterAxisSizingMode = "FIXED";
  card.counterAxisAlignItems = "CENTER";
  card.primaryAxisAlignItems = anchor === "bottom" ? "MAX" : "MIN";
  card.paddingTop = stack && anchor === "top" ? Math.max(0, stack.top) : 0;
  card.paddingBottom = stack && anchor === "bottom" ? Math.max(0, H - stack.bottom) : 0;
  card.clipsContent = true;
  card.fills = [];
  const c = figma.viewport.center;
  card.x = Math.round(c.x - W / 2);
  card.y = Math.round(c.y - H / 2);

  // a child that sits where it is, outside the flow
  const pin = (node, x, y) => {
    card.appendChild(node);
    node.layoutPositioning = "ABSOLUTE";
    node.x = x;
    node.y = y;
    node.constraints = { horizontal: "SCALE", vertical: "SCALE" };
  };

  // photo
  const image = figma.createImage(base64Bytes(spec.background));
  const photo = figma.createRectangle();
  photo.name = "Photo";
  photo.resize(W, H);
  photo.fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: image.hash }];
  pin(photo, 0, 0);

  // strips: one group per row, floaters together
  const shapes = spec.shapes || [];
  if (shapes.length) {
    const strips = figma.createFrame();
    strips.name = "Strips";
    strips.resize(W, H);
    strips.fills = [];
    strips.clipsContent = false;
    const byRow = new Map();
    const floaters = [];
    for (const sh of shapes) {
      const r = figma.createRectangle();
      r.name = sh.floater ? "Floater" : "Stripe";
      r.x = sh.x;
      r.y = sh.y;
      r.resize(Math.max(0.01, sh.w), Math.max(0.01, sh.h));
      r.fills = [{ type: "SOLID", color: hex(sh.fill) }];
      strips.appendChild(r);
      if (sh.floater) floaters.push(r);
      else {
        if (!byRow.has(sh.row)) byRow.set(sh.row, []);
        byRow.get(sh.row).push(r);
      }
    }
    for (const [row, rects] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
      const g = figma.group(rects, strips);
      g.name = "Row " + (row + 1);
    }
    if (floaters.length) figma.group(floaters, strips).name = "Floaters";
    pin(strips, 0, 0);
  }

  // logo: the SVG as vectors
  if (spec.logo && spec.logo.svg) {
    const src = spec.logo.color === "white" ? spec.logo.svg.replace(/fill="black"/g, 'fill="white"') : spec.logo.svg;
    const logo = figma.createNodeFromSvg(src);
    logo.name = "Logo";
    logo.resize(spec.logo.w, spec.logo.h);
    pin(logo, spec.logo.x, spec.logo.y);
  }

  const stackFrame = (name) => {
    const f = figma.createFrame();
    f.name = name;
    f.fills = [];
    f.clipsContent = false;
    f.layoutMode = "VERTICAL";
    f.primaryAxisSizingMode = "AUTO";
    f.counterAxisSizingMode = "AUTO";
    f.counterAxisAlignItems = "CENTER";
    f.itemSpacing = gap;
    return f;
  };

  const block = (b) => {
    const f = figma.createFrame();
    f.name = b.text;
    f.fills = [{ type: "SOLID", color: bgFill }];
    f.clipsContent = false;
    f.layoutMode = "HORIZONTAL";
    f.primaryAxisSizingMode = "AUTO";
    f.counterAxisSizingMode = "AUTO";
    f.paddingLeft = b.padX;
    f.paddingRight = b.padX;
    f.paddingTop = b.padTop;
    f.paddingBottom = b.padBottom;
    const t = figma.createText();
    t.fontName = font;
    t.fontSize = b.fs;
    t.characters = b.text;
    t.fills = [{ type: "SOLID", color: textFill }];
    t.letterSpacing = { unit: "PERCENT", value: b.tracking * 100 };
    t.lineHeight = { unit: "PIXELS", value: b.fs };
    t.textAutoResize = "WIDTH_AND_HEIGHT";
    try {
      t.leadingTrim = "CAP_HEIGHT"; // the block holds cap height + padding, as in the tool
    } catch (e) {
      // older Figma: the line box stays, the block is a little taller
    }
    f.appendChild(t);
    return f;
  };

  const row = (r) => {
    const f = figma.createFrame();
    f.name = r.key;
    f.fills = [];
    f.clipsContent = false;
    f.layoutMode = "HORIZONTAL";
    f.primaryAxisSizingMode = "AUTO";
    f.counterAxisSizingMode = "AUTO";
    f.counterAxisAlignItems = "MIN";
    f.itemSpacing = gap;
    // the B2B row is centred as if the badge had a twin on the right
    if (r.shift < 0) f.paddingRight = -2 * r.shift;
    else if (r.shift > 0) f.paddingLeft = 2 * r.shift;
    for (const b of r.blocks) f.appendChild(block(b));
    return f;
  };

  const rows = spec.rows || [];
  const stacked = rows.filter((r) => r.stacked);
  if (stacked.length && stack) {
    const s = stackFrame("Text");
    for (const r of stacked) s.appendChild(row(r));
    card.appendChild(s); // the flowing child: pinned to the edge, centred
  }
  // free rows: consecutive rows of one key form their own little stack, in
  // a card-wide wrapper as high as themselves so they stay centred on edit
  let i = 0;
  const free = rows.filter((r) => !r.stacked);
  while (i < free.length) {
    const key = free[i].key;
    const group = [];
    while (i < free.length && free[i].key === key) group.push(free[i++]);
    const wrap = figma.createFrame();
    wrap.name = key;
    wrap.fills = [];
    wrap.clipsContent = false;
    wrap.layoutMode = "HORIZONTAL";
    wrap.resize(W, group[0].h);
    wrap.primaryAxisSizingMode = "FIXED";
    wrap.counterAxisSizingMode = "AUTO";
    wrap.primaryAxisAlignItems = "CENTER";
    const s = stackFrame(key);
    for (const r of group) s.appendChild(row(r));
    wrap.appendChild(s);
    pin(wrap, 0, group[0].top);
  }
  return card;
}
