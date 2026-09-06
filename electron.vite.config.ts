import { resolve } from "path";

import { defineConfig } from "electron-vite";

/**
 * Why this file exists at all.
 *
 * electron-vite has sane defaults for all three targets — src/main/index.ts, src/preload/index.ts,
 * and src/renderer — and until now the app shipped with no config precisely because those defaults
 * were enough. They stopped being enough the moment the main process gained a native dependency.
 *
 * `loopback-capture` is a .node addon loaded through `bindings`, which finds the binary with a
 * runtime `require()` of a path it computes at call time. Rollup cannot see through that: it inlines
 * the package into the main bundle and rewrites the dynamic require into a stub that throws
 * "Could not dynamically require ...". The throw is caught in WindowsLoopbackRuntime.start() and
 * surfaces as R2 / native-loopback-adapter-unavailable, so the app fails closed and visibly — but
 * it can never capture, in dev or in a package, because `electron-vite dev` runs the same rollup
 * pass over the main process.
 *
 * Leaving the addon external is the fix: `require("loopback-capture")` then survives into out/main
 * as a real require, resolves up to node_modules, and `bindings` computes the module root correctly
 * instead of looking for build/Release next to the bundle.
 *
 * The list is explicit rather than `externalizeDepsPlugin()`, for two reasons. The plugin reads
 * `pkg.dependencies` only, and `loopback-capture` is an optionalDependency — so the plugin would
 * silently not cover the one package that needs covering. And externalizing everything else would
 * change how the other deps ship today for no reason this fix requires.
 *
 * WHY PRELOAD AND RENDERER ARE SPELLED OUT BELOW
 *   They only restate what electron-vite already infers. The moment a config file exists, the
 *   inference stops: electron-vite builds the sections it is given and warns "renderer and preload
 *   config is missing" for the rest, which would have shipped a main process with no preload and no
 *   UI behind it. These three blocks are the defaults, written down, so that adding one option to
 *   `main` does not silently delete the other two targets.
 */
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/main/index.ts"),
        // `bindings` too: it is loopback-capture's loader, and bundling it reintroduces the same
        // dynamic-require rewrite one level down.
        external: ["loopback-capture", "bindings"],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/preload/index.ts"),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
  },
});
