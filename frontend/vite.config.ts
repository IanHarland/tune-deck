import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The service worker has to precache the app shell AND the hashed JS/CSS it
// pulls in, or a cached shell still blocks on the network for its bundle — a
// ~20s wait against the scale-to-zero machine, and the splash stays up forever
// if that fetch dies. Vite only knows those filenames at build time, so stamp
// them into dist/sw.js here, along with a version derived from them (a new build
// = a new cache, with no manual bump to forget).
function swPrecache() {
  let outDir = "dist";
  return {
    name: "sw-precache",
    apply: "build" as const,
    configResolved(cfg: { root: string; build: { outDir: string } }) {
      outDir = path.resolve(cfg.root, cfg.build.outDir);
    },
    closeBundle() {
      const swPath = path.join(outDir, "sw.js");
      const assetDir = path.join(outDir, "assets");
      if (!fs.existsSync(swPath) || !fs.existsSync(assetDir)) return;

      const assets = fs
        .readdirSync(assetDir)
        .filter((f) => /\.(js|css)$/.test(f))
        .sort()
        .map((f) => `/assets/${f}`);
      const urls = ["/", ...assets];
      const version = crypto
        .createHash("sha256")
        .update(urls.join("|"))
        .digest("hex")
        .slice(0, 8);

      // Each substitution is checked on its own: a half-stamped worker ships a
      // real bug (an unbumped BUILD pins the cache name forever, an unstamped
      // PRECACHE brings back the cold-start hang), and would otherwise pass a
      // did-anything-change check on the strength of the other one.
      const stamp = (src: string, placeholder: RegExp, replacement: string) => {
        const out = src.replace(placeholder, replacement);
        if (out === src) {
          throw new Error(`sw-precache: ${placeholder} not found in sw.js`);
        }
        return out;
      };

      let sw = fs.readFileSync(swPath, "utf8");
      sw = stamp(
        sw,
        /const BUILD = "dev"; \/\*__BUILD__\*\//,
        `const BUILD = ${JSON.stringify(version)};`,
      );
      sw = stamp(
        sw,
        /const PRECACHE = \["\/"\]; \/\*__PRECACHE_URLS__\*\//,
        `const PRECACHE = ${JSON.stringify(urls)};`,
      );
      fs.writeFileSync(swPath, sw);
      console.log(`sw-precache: build ${version}, ${urls.length} urls precached`);
    },
  };
}

// Dev: proxy API calls to the Flask backend on :8080.
// Prod: Flask serves the built files, so same-origin /api just works.
export default defineConfig({
  plugins: [react(), swPrecache()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
    },
  },
  build: {
    outDir: "dist",
  },
});
