// Illustrator export: the card as an SVG Illustrator opens with everything
// live. The artboard is the card, the photo and the edge strips reach into
// the bleed around it, every stripe and floater is a rectangle, the logo
// its vector paths, every word a text object (Avantt Bold, with the
// tracking) with its block as a rectangle behind it. Illustrator has no
// text-following block, so a block is a plain rectangle there.
import { LABEL_WEIGHT } from "./engine";
import type { IdmlSpec } from "./indesign";
import { bleedFor, extendToBleed } from "./indesign";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (n: number) => (Math.round(n * 100) / 100).toString();

function svgViewBoxWidth(svg: string): number {
  const vb = /viewBox="([^"]+)"/.exec(svg);
  return vb ? parseFloat(vb[1].split(/\s+/)[2]) : 1080;
}
/** The paths of an SVG as path elements, black ink in `ink`. */
function svgPaths(svg: string, ink: string): string[] {
  const paths: string[] = [];
  for (const m of svg.matchAll(/<path\s+([^>]*)\/>/g)) {
    const attrs = m[1];
    const d = /(?:^|\s)d="([^"]*)"/.exec(attrs)?.[1];
    let fill = /fill="([^"]*)"/.exec(attrs)?.[1] || "black";
    if (!d || fill === "none") continue;
    if (fill === "black") fill = ink;
    paths.push(`<path d="${d}" fill="${fill}"/>`);
  }
  return paths;
}

export function buildIllustratorSvg(spec: IdmlSpec): { svg: string; name: string } {
  const W = spec.w;
  const H = spec.h;
  const bleed = bleedFor(spec);
  const out: string[] = [];
  out.push(
    `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}px" height="${H}px" viewBox="0 0 ${W} ${H}" overflow="visible">`,
  );
  out.push(`<title>${esc(spec.name)}</title>`);
  // the photo, covering the bleed
  out.push(
    `<image id="Photo" x="${num(-bleed)}" y="${num(-bleed)}" width="${num(W + 2 * bleed)}" height="${num(H + 2 * bleed)}" preserveAspectRatio="xMidYMid slice" xlink:href="${spec.background}"/>`,
  );
  // strips
  const shapes = extendToBleed(spec, bleed);
  const rows = new Map<number, typeof shapes>();
  const floaters: typeof shapes = [];
  for (const sh of shapes) {
    if (sh.floater) floaters.push(sh);
    else {
      if (!rows.has(sh.row)) rows.set(sh.row, []);
      rows.get(sh.row)!.push(sh);
    }
  }
  const rect = (sh: (typeof shapes)[number]) => `<rect x="${num(sh.x)}" y="${num(sh.y)}" width="${num(sh.w)}" height="${num(sh.h)}" fill="${sh.fill}"/>`;
  if (rows.size) {
    out.push(`<g id="Strips">`);
    for (const [row, list] of [...rows.entries()].sort((a, b) => a[0] - b[0])) out.push(`<g id="Row ${row + 1}">${list.map(rect).join("")}</g>`);
    if (floaters.length) out.push(`<g id="Floaters">${floaters.map(rect).join("")}</g>`);
    out.push(`</g>`);
  }
  // the logo: the SVG's paths, scaled into place
  if (spec.logo) {
    const { svg, color, x, y, w } = spec.logo;
    const vb = /viewBox="([^"]+)"/.exec(svg);
    const vbw = vb ? parseFloat(vb[1].split(/\s+/)[2]) : 1080;
    const s = w / vbw;
    const paths: string[] = [];
    for (const m of svg.matchAll(/<path\s+([^>]*)\/>/g)) {
      const attrs = m[1];
      const d = /(?:^|\s)d="([^"]*)"/.exec(attrs)?.[1];
      let fill = /fill="([^"]*)"/.exec(attrs)?.[1] || "black";
      if (!d || fill === "none") continue;
      if (fill === "black" && color === "white") fill = "white";
      paths.push(`<path d="${d}" fill="${fill}"/>`);
    }
    out.push(`<g id="Logo" transform="translate(${num(x)} ${num(y)}) scale(${num(s)})">${paths.join("")}</g>`);
  }
  // the text: a rectangle and a word per block
  out.push(`<g id="Text">`);
  for (const r of spec.rows) {
    let x = r.cx + r.shift - r.w / 2;
    const parts: string[] = [];
    for (const b of r.blocks) {
      parts.push(`<g id="${esc(b.text)}">`);
      parts.push(`<rect x="${num(x)}" y="${num(r.top)}" width="${num(b.w)}" height="${num(b.h)}" fill="${spec.colors.bg}"/>`);
      if (b.icon) {
        // the icon's paths where the text would stand, in the text colour
        parts.push(`<g transform="translate(${num(x + b.padX)} ${num(r.top + b.padTop)}) scale(${num(b.icon.w / svgViewBoxWidth(b.icon.svg))})">${svgPaths(b.icon.svg, spec.colors.text).join("")}</g>`);
      } else
        parts.push(
          `<text x="${num(x + b.padX)}" y="${num(r.top + b.padTop + b.capH)}" font-family="'Avantt-Bold', '${esc(spec.font.family)}'" font-weight="${LABEL_WEIGHT}" font-size="${num(b.fs)}" letter-spacing="${num(b.tracking * b.fs)}" style="letter-spacing:${num(b.tracking * b.fs)}px" fill="${spec.colors.text}" xml:space="preserve">${esc(b.text)}</text>`,
        );
      parts.push(`</g>`);
      x += b.w + spec.gap;
    }
    out.push(`<g id="${esc(r.key)}">${parts.join("")}</g>`);
  }
  out.push(`</g></svg>`);
  const stem = spec.name.replace(/[:/\\]/g, "x").replace(/\s+/g, " ").trim() || "Artist card";
  return { svg: out.join("\n"), name: `${stem} (Illustrator).svg` };
}
