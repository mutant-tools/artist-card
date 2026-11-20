// InDesign export: the card as an IDML package (InDesign's open XML format),
// built on the TMB artist template's resources (its swatches, styles, the
// Avantt font list, a 1080-wide page). Everything is live: the photo a
// placed image, every stripe and floater a rectangle, the logo vector
// paths, every word a text frame that auto-sizes with its text, the block
// behind it paragraph shading from cap height to baseline plus the padding,
// so the block follows the text when it is edited. (InDesign's shading
// origins are ascent, baseline and leading only, so the block is measured
// from the baseline: cap height + padding up, padding down.)
import { strToU8, zipSync } from "fflate";
import designmapTpl from "./idml/designmap.xml?raw";
import fontsXml from "./idml/Fonts.xml?raw";
import graphicTpl from "./idml/Graphic.xml?raw";
import stylesXml from "./idml/Styles.xml?raw";
import prefsTpl from "./idml/Preferences.xml?raw";
import masterXml from "./idml/MasterSpread.xml?raw";
import backingXml from "./idml/BackingStory.xml?raw";
import tagsXml from "./idml/Tags.xml?raw";
import { LABEL_WEIGHT } from "./engine";
import type { SpecRow, SpecShape } from "./engine";

export interface IdmlSpec {
  name: string;
  w: number;
  h: number;
  gap: number;
  font: { family: string; style: string };
  colors: { bg: string; text: string };
  rows: SpecRow[];
  shapes: SpecShape[];
  logo: { svg: string; color: string; x: number; y: number; w: number; h: number } | null;
  background: string; // data URL (JPEG), the photo alone
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (n: number) => (Math.round(n * 1000) / 1000).toString();

// ---------- SVG paths -> InDesign path geometry ----------
interface Pt {
  x: number;
  y: number;
}
interface PathPoint {
  a: Pt;
  l: Pt; // left direction (incoming control)
  r: Pt; // right direction (outgoing control)
}
/** Parse an SVG path (M L H V C S Z, absolute or relative) into closed subpaths of bezier points. */
function parseSvgPath(d: string): PathPoint[][] {
  const tokens = d.match(/[MLHVCSZmlhvcsz]|-?\d*\.?\d+(?:e-?\d+)?/g) || [];
  const subs: PathPoint[][] = [];
  let cur: PathPoint[] = [];
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let cmd = "";
  let i = 0;
  let lastC2 = null as Pt | null;
  const n = () => parseFloat(tokens[i++]);
  const close = () => {
    if (cur.length) subs.push(cur);
    cur = [];
  };
  const moveTo = (nx: number, ny: number) => {
    close();
    x = sx = nx;
    y = sy = ny;
    cur.push({ a: { x, y }, l: { x, y }, r: { x, y } });
    lastC2 = null;
  };
  const lineTo = (nx: number, ny: number) => {
    x = nx;
    y = ny;
    cur.push({ a: { x, y }, l: { x, y }, r: { x, y } });
    lastC2 = null;
  };
  const curveTo = (c1: Pt, c2: Pt, p: Pt) => {
    if (cur.length) cur[cur.length - 1].r = c1;
    cur.push({ a: p, l: c2, r: p });
    x = p.x;
    y = p.y;
    lastC2 = c2;
  };
  while (i < tokens.length) {
    const t = tokens[i];
    if (/[A-Za-z]/.test(t)) {
      cmd = t;
      i++;
      if (cmd === "Z" || cmd === "z") {
        close();
        x = sx;
        y = sy;
        continue;
      }
    }
    switch (cmd) {
      case "M":
        moveTo(n(), n());
        cmd = "L";
        break;
      case "m":
        moveTo(x + n(), y + n());
        cmd = "l";
        break;
      case "L":
        lineTo(n(), n());
        break;
      case "l":
        lineTo(x + n(), y + n());
        break;
      case "H":
        lineTo(n(), y);
        break;
      case "h":
        lineTo(x + n(), y);
        break;
      case "V":
        lineTo(x, n());
        break;
      case "v":
        lineTo(x, y + n());
        break;
      case "C": {
        const c1 = { x: n(), y: n() };
        const c2 = { x: n(), y: n() };
        curveTo(c1, c2, { x: n(), y: n() });
        break;
      }
      case "c": {
        const c1 = { x: x + n(), y: y + n() };
        const c2 = { x: x + n(), y: y + n() };
        curveTo(c1, c2, { x: x + n(), y: y + n() });
        break;
      }
      case "S":
      case "s": {
        const rel = cmd === "s";
        const c1 = lastC2 ? { x: 2 * x - lastC2.x, y: 2 * y - lastC2.y } : { x, y };
        const c2 = rel ? { x: x + n(), y: y + n() } : { x: n(), y: n() };
        const p = rel ? { x: x + n(), y: y + n() } : { x: n(), y: n() };
        curveTo(c1, c2, p);
        break;
      }
      default:
        i++; // unknown: skip a token
    }
  }
  close();
  // a closing point that repeats the start would show as a doubled node
  for (const s of subs) {
    if (s.length > 1) {
      const f = s[0];
      const l = s[s.length - 1];
      if (Math.abs(f.a.x - l.a.x) < 1e-6 && Math.abs(f.a.y - l.a.y) < 1e-6) {
        f.l = l.l;
        s.pop();
      }
    }
  }
  return subs.filter((s) => s.length > 1);
}

// ---------- the package ----------
let idCounter = 0;
const nextId = () => `tq${(idCounter++).toString(36)}`;

function pathGeometry(subs: PathPoint[][], tx: (p: Pt) => Pt, open = false): string {
  const parts = subs.map((s) => {
    const pts = s
      .map((p) => {
        const a = tx(p.a);
        const l = tx(p.l);
        const r = tx(p.r);
        return `<PathPointType Anchor="${num(a.x)} ${num(a.y)}" LeftDirection="${num(l.x)} ${num(l.y)}" RightDirection="${num(r.x)} ${num(r.y)}" />`;
      })
      .join("");
    return `<GeometryPathType PathOpen="${open}"><PathPointArray>${pts}</PathPointArray></GeometryPathType>`;
  });
  return `<Properties><PathGeometry>${parts.join("")}</PathGeometry></Properties>`;
}

function rectGeometry(x: number, y: number, w: number, h: number): string {
  const p = (px: number, py: number): PathPoint => ({ a: { x: px, y: py }, l: { x: px, y: py }, r: { x: px, y: py } });
  return pathGeometry([[p(x, y), p(x, y + h), p(x + w, y + h), p(x + w, y)]], (q) => q);
}

const ITEM_COMMON = 'Visible="true" Name="$ID/" AppliedObjectStyle="ObjectStyle/$ID/[None]" LocalDisplaySetting="Default"';

/** Print bleed for a card: 3 mm as if the short side were an A4 width (210 mm), so 15 px at 1080. */
export function bleedFor(spec: { w: number; h: number }): number {
  return Math.round((Math.min(spec.w, spec.h) * 3) / 210);
}
/** Everything that touches a page edge reaches into the bleed: the photo, and the stripes on the edges. */
export function extendToBleed(spec: { w: number; h: number; shapes: SpecShape[] }, bleed: number): SpecShape[] {
  const W = spec.w;
  const H = spec.h;
  const eps = 0.5;
  return spec.shapes.map((sh) => {
    if (sh.floater) return sh;
    let { x, y, w, h } = sh;
    if (x <= eps) {
      w += x + bleed;
      x = -bleed;
    }
    if (x + w >= W - eps) w = W + bleed - x;
    if (y <= eps) {
      h += y + bleed;
      y = -bleed;
    }
    if (y + h >= H - eps) h = H + bleed - y;
    return { ...sh, x, y, w, h };
  });
}

export function buildIdml(spec: IdmlSpec): { files: Record<string, Uint8Array>; stem: string } {
  idCounter = 0;
  const W = spec.w;
  const H = spec.h;
  const bleed = bleedFor(spec);
  const ox = -W / 2; // page origin in spread coordinates
  const oy = -H / 2;
  const swatches = new Map<string, string>(); // hex -> Color self
  const colour = (hex: string) => {
    const h = hex.replace("#", "").toUpperCase();
    if (!swatches.has(h)) swatches.set(h, `Color/tq_${h}`);
    return swatches.get(h)!;
  };
  const items: string[] = [];
  const stories: Record<string, string> = {};

  // the photo
  const photoStem = "photo.jpg";
  const photoBytes = dataUrlBytes(spec.background);
  const imgDims = jpegSize(photoBytes) || { w: W * 2, h: H * 2 };
  const scale = Math.max((W + 2 * bleed) / imgDims.w, (H + 2 * bleed) / imgDims.h);
  {
    const rid = nextId();
    const iid = nextId();
    const lid = nextId();
    const dw = imgDims.w * scale;
    const dh = imgDims.h * scale;
    items.push(
      `<Rectangle Self="${rid}" ContentType="GraphicType" ${ITEM_COMMON} FillColor="Swatch/None" StrokeColor="Swatch/None" StrokeWeight="0" ItemTransform="1 0 0 1 ${num(ox - bleed)} ${num(oy - bleed)}">` +
        rectGeometry(0, 0, W + 2 * bleed, H + 2 * bleed) +
        `<FrameFittingOption FittingOnEmptyFrame="FillProportionally" />` +
        `<Image Self="${iid}" Space="$ID/#Links_RGB" ActualPpi="72 72" EffectivePpi="${num(72 / scale)} ${num(72 / scale)}" ImageTypeName="$ID/JPEG" ItemTransform="${num(scale)} 0 0 ${num(scale)} ${num((W + 2 * bleed - dw) / 2)} ${num((H + 2 * bleed - dh) / 2)}" ${ITEM_COMMON}>` +
        `<Properties><Profile type="string">$ID/Use Document Default</Profile><GraphicBounds Left="0" Top="0" Right="${num(imgDims.w)}" Bottom="${num(imgDims.h)}" /></Properties>` +
        `<Link Self="${lid}" AssetURL="$ID/" AssetID="$ID/" LinkResourceURI="file:Links/${photoStem}" LinkResourceFormat="$ID/JPEG" StoredState="Normal" LinkClassID="35906" LinkClientID="257" LinkResourceModified="false" LinkObjectModified="false" ShowInUI="true" CanEmbed="true" CanUnembed="true" CanPackage="true" ImportPolicy="NoAutoImport" ExportPolicy="NoAutoExport" LinkResourceSize="0~${photoBytes.length.toString(16)}" />` +
        `</Image></Rectangle>`,
    );
  }

  // strips: one group per row, the floaters together
  const byRow = new Map<number, SpecShape[]>();
  const floaters: SpecShape[] = [];
  for (const sh of extendToBleed(spec, bleed)) {
    if (sh.floater) floaters.push(sh);
    else {
      if (!byRow.has(sh.row)) byRow.set(sh.row, []);
      byRow.get(sh.row)!.push(sh);
    }
  }
  const rectItem = (sh: SpecShape, name: string) =>
    `<Rectangle Self="${nextId()}" ContentType="Unassigned" ${ITEM_COMMON.replace('Name="$ID/"', `Name="${esc(name)}"`)} FillColor="${colour(sh.fill)}" StrokeColor="Swatch/None" StrokeWeight="0" ItemTransform="1 0 0 1 ${num(ox + sh.x)} ${num(oy + sh.y)}">${rectGeometry(0, 0, Math.max(0.01, sh.w), Math.max(0.01, sh.h))}</Rectangle>`;
  const group = (name: string, children: string[]) =>
    `<Group Self="${nextId()}" ${ITEM_COMMON.replace('Name="$ID/"', `Name="${esc(name)}"`)} ItemTransform="1 0 0 1 0 0">${children.join("")}</Group>`;
  const rowGroups: string[] = [];
  for (const [row, shapes] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) rowGroups.push(group(`Row ${row + 1}`, shapes.map((s) => rectItem(s, "Stripe"))));
  if (floaters.length) rowGroups.push(group("Floaters", floaters.map((s) => rectItem(s, "Floater"))));
  if (rowGroups.length) items.push(group("Strips", rowGroups));

  // the logo: every SVG path a polygon
  if (spec.logo) {
    const { svg, color, x, y, w } = spec.logo;
    const vb = /viewBox="([^"]+)"/.exec(svg);
    const vbw = vb ? parseFloat(vb[1].split(/\s+/)[2]) : 1080;
    const s = w / vbw;
    const polys: string[] = [];
    for (const m of svg.matchAll(/<path\s+([^>]*)\/>/g)) {
      const attrs = m[1];
      const d = /(?:^|\s)d="([^"]*)"/.exec(attrs)?.[1];
      let fill = /fill="([^"]*)"/.exec(attrs)?.[1] || "black";
      if (!d || fill === "none") continue;
      if (fill === "black" && color === "white") fill = "white";
      const hex = fill === "black" ? "#000000" : fill === "white" ? "#FFFFFF" : fill;
      const subs = parseSvgPath(d);
      if (!subs.length) continue;
      polys.push(
        `<Polygon Self="${nextId()}" ContentType="Unassigned" ${ITEM_COMMON} FillColor="${colour(hex)}" StrokeColor="Swatch/None" StrokeWeight="0" ItemTransform="1 0 0 1 ${num(ox + x)} ${num(oy + y)}">${pathGeometry(subs, (p) => ({ x: p.x * s, y: p.y * s }))}</Polygon>`,
      );
    }
    if (polys.length) items.push(group("Logo", polys));
  }

  // the text: one auto-sizing frame per word, the block as paragraph shading
  const bg = colour(spec.colors.bg);
  const fg = colour(spec.colors.text);
  for (const r of spec.rows) {
    let x = r.cx + r.shift - r.w / 2;
    for (const b of r.blocks) {
      if (b.icon) {
        // the block as a rectangle, the icon's paths in the text colour on it
        const vb = /viewBox="([^"]+)"/.exec(b.icon.svg);
        const vbw = vb ? parseFloat(vb[1].split(/\s+/)[2]) : 72;
        const s = b.icon.w / vbw;
        const parts: string[] = [
          `<Rectangle Self="${nextId()}" ContentType="Unassigned" ${ITEM_COMMON.replace('Name="$ID/"', 'Name="Block"')} FillColor="${bg}" StrokeColor="Swatch/None" StrokeWeight="0" ItemTransform="1 0 0 1 ${num(ox + x)} ${num(oy + r.top)}">${rectGeometry(0, 0, b.w, b.h)}</Rectangle>`,
        ];
        for (const m of b.icon.svg.matchAll(/<path\s+([^>]*)\/>/g)) {
          const d = /(?:^|\s)d="([^"]*)"/.exec(m[1])?.[1];
          const subs = d ? parseSvgPath(d) : [];
          if (!subs.length) continue;
          parts.push(
            `<Polygon Self="${nextId()}" ContentType="Unassigned" ${ITEM_COMMON} FillColor="${fg}" StrokeColor="Swatch/None" StrokeWeight="0" ItemTransform="1 0 0 1 ${num(ox + x + b.padX)} ${num(oy + r.top + b.padTop)}">${pathGeometry(subs, (p) => ({ x: p.x * s, y: p.y * s }))}</Polygon>`,
          );
        }
        items.push(group(b.text, parts));
        x += b.w + spec.gap;
        continue;
      }
      const fid = nextId();
      const sid = nextId();
      items.push(
        `<TextFrame Self="${fid}" ParentStory="${sid}" PreviousTextFrame="n" NextTextFrame="n" ContentType="TextType" ${ITEM_COMMON.replace('Name="$ID/"', `Name="${esc(b.text.replace(/\s+/g, " ").slice(0, 60))}"`)} FillColor="Swatch/None" StrokeColor="Swatch/None" StrokeWeight="0" ItemTransform="1 0 0 1 ${num(ox + x)} ${num(oy + r.top)}">` +
          rectGeometry(0, 0, b.w, b.h) +
          `<TextFramePreference TextColumnCount="1" TextColumnFixedWidth="${num(b.w)}" FirstBaselineOffset="CapHeight" MinimumFirstBaselineOffset="0" VerticalJustification="TopAlign" AutoSizingType="HeightAndWidth" AutoSizingReferencePoint="TopCenterPoint" UseMinimumHeightForAutoSizing="false" MinimumHeightForAutoSizing="0" UseMinimumWidthForAutoSizing="false" MinimumWidthForAutoSizing="0" UseNoLineBreaksForAutoSizing="true">` +
          `<Properties><InsetSpacing type="list"><ListItem type="unit">${num(b.padTop)}</ListItem><ListItem type="unit">${num(b.padX)}</ListItem><ListItem type="unit">${num(b.padBottom)}</ListItem><ListItem type="unit">${num(b.padX)}</ListItem></InsetSpacing></Properties>` +
          `</TextFramePreference>` +
          `<TextWrapPreference Inverse="false" ApplyToMasterPageOnly="false" TextWrapSide="BothSides" TextWrapMode="None"><Properties><TextWrapOffset Top="0" Left="0" Bottom="0" Right="0" /></Properties></TextWrapPreference>` +
          `</TextFrame>`,
      );
      stories[sid] =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="21.0">` +
        `<Story Self="${sid}" UserText="true" IsEndnoteStory="false" AppliedTOCStyle="n" TrackChanges="false" StoryTitle="$ID/" AppliedNamedGrid="n">` +
        `<StoryPreference OpticalMarginAlignment="false" OpticalMarginSize="12" FrameType="TextFrameType" StoryOrientation="Horizontal" StoryDirection="LeftToRightDirection" />` +
        `<InCopyExportOption IncludeGraphicProxies="true" IncludeAllResources="false" />` +
        `<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/$ID/NormalParagraphStyle" Justification="CenterAlign" ParagraphShadingOn="true" ParagraphShadingTint="100" ParagraphShadingWidth="TextWidth" ParagraphShadingTopOrigin="BaselineTopOrigin" ParagraphShadingBottomOrigin="BaselineBottomOrigin" ParagraphShadingTopOffset="${num(b.capH + b.padTop)}" ParagraphShadingBottomOffset="${num(b.padBottom)}" ParagraphShadingLeftOffset="${num(b.padX)}" ParagraphShadingRightOffset="${num(b.padX)}" ParagraphShadingClipToFrame="false">` +
        `<Properties><ParagraphShadingColor type="object">${bg}</ParagraphShadingColor></Properties>` +
        `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]" FontStyle="${esc(spec.font.style)}" PointSize="${num(b.fs)}" Tracking="${num(b.tracking * 1000)}" FillColor="${fg}">` +
        `<Properties><Leading type="unit">${num(b.lines ? (b.lineH ?? b.fs) : b.capH)}</Leading><AppliedFont type="string">${esc(spec.font.family)}</AppliedFont></Properties>` +
        `<Content>${esc(b.lines ? b.lines.join("\u2028") : b.text)}</Content></CharacterStyleRange></ParagraphStyleRange></Story></idPkg:Story>`;
      x += b.w + spec.gap;
    }
  }

  // the spread: one page, the items in paint order
  const spreadId = nextId();
  const pageId = nextId();
  const spread =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<idPkg:Spread xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="21.0">` +
    `<Spread Self="${spreadId}" PageTransitionType="None" PageTransitionDirection="NotApplicable" PageTransitionDuration="Medium" ShowMasterItems="true" PageCount="1" BindingLocation="0" SpreadHidden="false" AllowPageShuffle="true" ItemTransform="1 0 0 1 0 0" FlattenerOverride="Default">` +
    `<Page Self="${pageId}" AppliedMaster="n" OverrideList="" Name="1" AppliedTrapPreset="TrapPreset/$ID/kDefaultTrapStyleName" GeometricBounds="0 0 ${num(H)} ${num(W)}" ItemTransform="1 0 0 1 ${num(ox)} ${num(oy)}">` +
    `<Properties><Descriptor type="list"><ListItem type="string"></ListItem><ListItem type="enumeration">Arabic</ListItem><ListItem type="boolean">true</ListItem><ListItem type="boolean">false</ListItem><ListItem type="long">1</ListItem><ListItem type="string"></ListItem></Descriptor><PageColor type="enumeration">UseMasterColor</PageColor></Properties>` +
    `<MarginPreference ColumnCount="1" ColumnGutter="12" Top="0" Bottom="0" Left="0" Right="0" ColumnDirection="Horizontal" ColumnsPositions="0 ${num(W)}" />` +
    `</Page>` +
    items.join("") +
    `</Spread></idPkg:Spread>`;

  // resources: the template's, plus our swatches and page size
  const swatchXml = [...swatches.entries()]
    .map(([hex, self]) => {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return `<Color Self="${self}" Model="Process" Space="RGB" ColorValue="${r} ${g} ${b}" ColorOverride="Normal" ConvertToHsb="false" AlternateSpace="NoAlternateColor" AlternateColorValue="" Name="${self.slice(6)}" ColorEditable="true" ColorRemovable="true" Visible="true" SwatchCreatorID="7937" SwatchColorGroupReference="n" />`;
    })
    .join("\n\t");
  const graphic = graphicTpl.replace("</idPkg:Graphic>", `\t${swatchXml}\n</idPkg:Graphic>`);
  const prefs = prefsTpl
    .replace(/PageHeight="[^"]*"/, `PageHeight="${num(H)}"`)
    .replace(/PageWidth="[^"]*"/, `PageWidth="${num(W)}"`)
    .replace(/DocumentBleedTopOffset="[^"]*"/, `DocumentBleedTopOffset="${num(bleed)}"`)
    .replace(/DocumentBleedBottomOffset="[^"]*"/, `DocumentBleedBottomOffset="${num(bleed)}"`)
    .replace(/DocumentBleedInsideOrLeftOffset="[^"]*"/, `DocumentBleedInsideOrLeftOffset="${num(bleed)}"`)
    .replace(/DocumentBleedOutsideOrRightOffset="[^"]*"/, `DocumentBleedOutsideOrRightOffset="${num(bleed)}"`)
    .replace(/DocumentBleedUniformSize="[^"]*"/, `DocumentBleedUniformSize="true"`);

  // the designmap: the template's, with our spread and stories instead of its own
  const storyIds = Object.keys(stories);
  let designmap = designmapTpl
    .replace(/\n\t<idPkg:Spread [^>]*\/>/g, "")
    .replace(/\n\t<idPkg:Story [^>]*\/>/g, "")
    .replace(/StoryList="[^"]*"/, `StoryList="${storyIds.join(" ")} ub1"`)
    .replace(/Name="[^"]*\.indd"/, `Name="${esc(spec.name)}.indd"`)
    .replace(/(<Section [^>]*?)Length="[^"]*"/, `$1Length="1"`)
    .replace(/(<Section [^>]*?)PageStart="[^"]*"/, `$1PageStart="${pageId}"`)
    .replace(/(<Section [^>]*?)AlternateLayoutLength="[^"]*"/, `$1AlternateLayoutLength="1"`)
    .replace(/(<idPkg:MasterSpread [^>]*\/>)/, `$1\n\t<idPkg:Spread src="Spreads/Spread_${spreadId}.xml" />`)
    .replace(/(<idPkg:BackingStory [^>]*\/>)/, `$1\n\t` + storyIds.map((id) => `<idPkg:Story src="Stories/Story_${id}.xml" />`).join("\n\t"));

  const files: Record<string, Uint8Array> = {};
  const put = (path: string, text: string) => (files[path] = strToU8(text));
  put("mimetype", "application/vnd.adobe.indesign-idml-package");
  put(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n\t<rootfiles>\n\t\t<rootfile full-path="designmap.xml" media-type="text/xml">\n\t\t</rootfile>\n\t</rootfiles>\n</container>\n`,
  );
  put("designmap.xml", designmap);
  put("Resources/Fonts.xml", fontsXml);
  put("Resources/Graphic.xml", graphic);
  put("Resources/Styles.xml", stylesXml);
  put("Resources/Preferences.xml", prefs);
  put("MasterSpreads/MasterSpread_ud6.xml", masterXml);
  put("XML/BackingStory.xml", backingXml);
  put("XML/Tags.xml", tagsXml);
  put(`Spreads/Spread_${spreadId}.xml`, spread);
  for (const [id, xml] of Object.entries(stories)) put(`Stories/Story_${id}.xml`, xml);

  const stem = spec.name.replace(/[:/\\]/g, "x").replace(/\s+/g, " ").trim() || "Artist card";
  return { files, stem };
}

/** The deliverable: a zip with the .idml and a Links folder holding the photo. */
export function buildIdmlZip(spec: IdmlSpec): { bytes: Uint8Array; name: string } {
  const { files, stem } = buildIdml(spec);
  // the mimetype entry must come first and be stored, as in every IDML
  const ordered: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  ordered["mimetype"] = [files["mimetype"], { level: 0 }];
  for (const [p, b] of Object.entries(files)) if (p !== "mimetype") ordered[p] = [b, { level: 6 }];
  const idml = zipSync(ordered);
  const bundle = zipSync({
    [`${stem}/${stem}.idml`]: [idml, { level: 0 }],
    [`${stem}/Links/photo.jpg`]: [dataUrlBytes(spec.background), { level: 0 }],
  });
  return { bytes: bundle, name: `${stem} (InDesign).zip` };
}

function dataUrlBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Width and height from a JPEG's SOF marker. */
function jpegSize(bytes: Uint8Array): { w: number; h: number } | null {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: (bytes[i + 5] << 8) | bytes[i + 6], w: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    i += 2 + len;
  }
  return null;
}

export const INDESIGN_FONT_WEIGHT = LABEL_WEIGHT;
