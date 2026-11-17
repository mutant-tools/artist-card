import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Built for GitHub Pages under a project path, so assets resolve relatively.
// Inside Figma (a code layer, see .figma/make) the dev server has to take the
// port and host it is handed.
const figma = Boolean(process.env.FIGMA || process.env.VITE_FIGMA);
// The Figma build is one self-contained HTML file (script and styles
// inlined): inside a presentation the layer is served from a sandbox where a
// separate module script does not load, while the page itself does.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "./" : "/",
  plugins: figma ? [viteSingleFile()] : [],
  server: figma
    ? {
        port: Number(process.env.PORT) || 5173,
        host: process.env.FIGMA_DEV_SERVER_HOST || "0.0.0.0",
        strictPort: true,
        allowedHosts: true as const,
      }
    : undefined,
}));
