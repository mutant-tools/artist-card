// Artist Card plugin: rebuilds a card from the tool's "Copy for Figma" /
// "Send to Figma" description as native, editable layers.
//
// Frame (card)
//   Background           image of everything but the text
//   Stack area           card-sized auto-layout, anchors the stack top or bottom
//     Stack              vertical auto-layout, centred
//       Row              horizontal auto-layout
//         Block          auto-layout with the padding, filled
//           Text         editable, cap-height trimmed
//   <key> area           one per free block row (same build as the stack)

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

  const card = figma.createFrame();
  card.name = spec.name || "Artist card";
  card.resize(W, H);
  card.clipsContent = true;
  card.fills = [];
  // drop it next to the current view
  const c = figma.viewport.center;
  card.x = Math.round(c.x - W / 2);
  card.y = Math.round(c.y - H / 2);

  const image = figma.createImage(base64Bytes(spec.background));
  const bg = figma.createRectangle();
  bg.name = "Background";
  bg.resize(W, H);
  bg.fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: image.hash }];
  bg.constraints = { horizontal: "SCALE", vertical: "SCALE" };
  card.appendChild(bg);

  // a card-sized auto-layout frame that pins its single child to the top
  // or bottom edge, centred: edits grow the child the right way
  const area = (name, anchor, top, bottom) => {
    const f = figma.createFrame();
    f.name = name;
    f.resize(W, H);
    f.fills = [];
    f.clipsContent = false;
    f.layoutMode = "VERTICAL";
    f.primaryAxisSizingMode = "FIXED";
    f.counterAxisSizingMode = "FIXED";
    f.counterAxisAlignItems = "CENTER";
    f.primaryAxisAlignItems = anchor === "bottom" ? "MAX" : "MIN";
    f.paddingTop = anchor === "bottom" ? 0 : Math.max(0, top);
    f.paddingBottom = anchor === "bottom" ? Math.max(0, H - bottom) : 0;
    f.constraints = { horizontal: "SCALE", vertical: "SCALE" };
    card.appendChild(f);
    return f;
  };

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
  if (stacked.length && spec.stack) {
    const a = area("Stack area", spec.stack.anchor, spec.stack.top, spec.stack.bottom);
    const s = stackFrame("Stack");
    for (const r of stacked) s.appendChild(row(r));
    a.appendChild(s);
  }
  // free rows: consecutive rows of one key form their own little stack
  let i = 0;
  const free = rows.filter((r) => !r.stacked);
  while (i < free.length) {
    const key = free[i].key;
    const group = [];
    while (i < free.length && free[i].key === key) group.push(free[i++]);
    const top = group[0].top;
    const bottom = group[group.length - 1].top + group[group.length - 1].h;
    const a = area(key + " area", "top", top, bottom);
    const s = stackFrame(key);
    for (const r of group) s.appendChild(row(r));
    a.appendChild(s);
  }
  return card;
}
