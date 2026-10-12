import path from "node:path";

import { defineConfig } from "vite";

import desktop from "./desktop.vite.config";
import { libavoidWasmAsset } from "./libavoid-wasm";

export default defineConfig({
  ...desktop,
  plugins: [libavoidWasmAsset(), ...(desktop.plugins ?? [])],
  base: "/",
  publicDir: path.resolve(__dirname, "web-public"),
  build: {
    ...desktop.build,
    outDir: "dist/web",
    emptyOutDir: true,
    manifest: false,
    copyPublicDir: true,
    rollupOptions: {
      ...desktop.build?.rollupOptions,
      input: { index: path.resolve(__dirname, "index.html") },
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
