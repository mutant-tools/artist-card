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

function inkBounds(img: HTMLImageElement, w: number, h: number): { top: number; bottom: number; left: number; right: number } {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { top: 0, bottom: 1, left: 0, right: 1 };
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  let top = -1;
  let bottom = -1;
  let left = w;
  let right = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 16) {
        if (top < 0) top = y;
        bottom = y + 1;
        if (x < left) left = x;
        if (x + 1 > right) right = x + 1;
      }
    }
  }
  return top < 0 ? { top: 0, bottom: 1, left: 0, right: 1 } : { top: top / h, bottom: bottom / h, left: left / w, right: right / w };
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
    const ink = inkBounds(b, 540, Math.round((540 * nh) / nw));
    const images: LogoImages = { svg: sized, black: b, white: w, w: nw, h: nh, inkTop: ink.top, inkBottom: ink.bottom, inkLeft: ink.left, inkRight: ink.right };
    setLogoImages(style, images);
    return images;
  } catch (e) {
    console.warn("[logo]", e);
    return null;
  }
}
