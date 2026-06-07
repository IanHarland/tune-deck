import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: proxy API calls to the Flask backend on :8080.
// Prod: Flask serves the built files, so same-origin /api just works.
export default defineConfig({
  plugins: [react()],
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
