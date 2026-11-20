// The Touquet logo (TOUQUET wordmark + "Le Crédit Mutuel donne le LA"): one
// SVG, drawn black or white. Like the fonts it ships with the built site
// only. The ink bounds are measured once so the bottom placement can mirror
// the top margin.
import { setLogoImages, type LogoImages, type LogoStyle } from "./engine";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("logo failed to load"));
    img.src = src;
  });
}

interface Ink {
  top: number;
  bottom: number;
  left: number;
  right: number;
  boneTop: number;
  boneBottom: number;
}
const NO_INK: Ink = { top: 0, bottom: 1, left: 0, right: 1, boneTop: 0, boneBottom: 1 };
/**
 * The ink's bounds, and the wordmark's: the tallest band of rows with ink
 * in them (the lockups stack a line above and a line below the wordmark,
 * both much lower than the letters).
 */
function inkBounds(img: HTMLImageElement, w: number, h: number): Ink {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return NO_INK;
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  let top = -1;
  let bottom = -1;
  let left = w;
  let right = -1;
  const rowHasInk: boolean[] = [];
  for (let y = 0; y < h; y++) {
    let any = false;
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 16) {
        any = true;
        if (top < 0) top = y;
        bottom = y + 1;
        if (x < left) left = x;
        if (x + 1 > right) right = x + 1;
      }
    }
    rowHasInk.push(any);
  }
  if (top < 0) return NO_INK;
  // the tallest run of ink rows, gaps of up to 2 rows bridged
  let boneTop = top;
  let boneBottom = top;
  let runStart = -1;
  let gap = 0;
  for (let y = 0; y <= h; y++) {
    const ink = y < h && rowHasInk[y];
    if (ink) {
      if (runStart < 0) runStart = y;
      gap = 0;
    } else if (runStart >= 0) {
      gap++;
      if (gap > 2 || y === h) {
        const end = y - gap + 1;
        if (end - runStart > boneBottom - boneTop) {
          boneTop = runStart;
          boneBottom = end;
        }
        runStart = -1;
        gap = 0;
      }
    }
  }
  return { top: top / h, bottom: bottom / h, left: left / w, right: right / w, boneTop: boneTop / h, boneBottom: boneBottom / h };
}

export async function loadLogo(style: LogoStyle, url: string): Promise<LogoImages | null> {
  try {
    const svg = await (await fetch(url)).text();
    const sized = svg.replace(/preserveAspectRatio="none"/, "");
    const white = sized.replace(/fill="black"/g, 'fill="white"');
    const toUrl = (s: string) => URL.createObjectURL(new Blob([s], { type: "image/svg+xml" }));
    const [b, w] = await Promise.all([loadImage(toUrl(sized)), loadImage(toUrl(white))]);
    const nw = b.naturalWidth || 1080;
    const nh = b.naturalHeight || 329;
    const ink = inkBounds(b, 1080, Math.round((1080 * nh) / nw));
    const images: LogoImages = {
      svg: sized,
      black: b,
      white: w,
      w: nw,
      h: nh,
      inkTop: ink.top,
      inkBottom: ink.bottom,
      inkLeft: ink.left,
      inkRight: ink.right,
      boneTop: ink.boneTop,
      boneBottom: ink.boneBottom,
    };
    setLogoImages(style, images);
    return images;
  } catch (e) {
    console.warn("[logo]", e);
    return null;
  }
}
