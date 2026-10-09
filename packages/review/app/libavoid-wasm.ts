import { createRequire } from "node:module";
import path from "node:path";

import type { Plugin } from "vite";

const require = createRequire(import.meta.url);

// The exports map only lists the JS entry points, so resolve the file through
// the package root instead of an exports lookup.
const libavoidWasm = path.join(
  path.dirname(require.resolve("@mr_mint/elkjs-libavoid")),
  "libavoid.wasm",
);

const WASM_IMPORT = "@mr_mint/elkjs-libavoid/dist/libavoid.wasm";

/**
 * `libavoid.wasm` ships inside `@mr_mint/elkjs-libavoid`, but the package's
 * exports map hides it, so the bundler refuses the `?url` asset import. Resolve
 * the specifier to the real file, keeping the asset query so it is emitted.
 */
export function libavoidWasmAsset(): Plugin {
  return {
    name: "libavoid-wasm-asset",
    enforce: "pre",
    resolveId(id) {
      const [specifier, query] = id.split("?", 2);

      if (specifier !== WASM_IMPORT) return null;

      return query ? `${libavoidWasm}?${query}` : libavoidWasm;
    },
  };
}
