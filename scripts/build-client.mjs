import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const client = resolve(root, "client");
const outdir = resolve(client, "dist");
const watch = process.argv.includes("--watch");

// Deliberately clean only the deployable output, never source files.
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp(resolve(client, "index.html"), resolve(outdir, "index.html"));

const common = {
  bundle: true,
  format: "esm",
  target: ["es2022"],
  outdir,
  assetNames: "generated-font-assets/[name]-[hash]",
  loader: { ".ttf": "file", ".woff": "file", ".woff2": "file" },
  logLevel: "info",
  // Monaco's package exports intentionally omit these source subpaths, while
  // both Monaco and y-monaco import them. Resolve them to the installed files.
  plugins: [{
    name: "monaco-esm-source",
    setup(build) {
      build.onResolve({ filter: /^monaco-editor\/(?:esm|dev|min)\// }, (args) => ({
        path: resolve(root, "node_modules", args.path),
      }));
    },
  }],
};

const appOptions = {
  ...common,
  entryPoints: { app: resolve(client, "src/app.js") },
  entryNames: "app",
};
const workerOptions = {
  ...common,
  entryPoints: { "editor.worker": resolve(client, "src/editor.worker.js") },
  entryNames: "editor.worker",
};

if (watch) {
  const [app, worker] = await Promise.all([context(appOptions), context(workerOptions)]);
  await Promise.all([app.watch(), worker.watch()]);
  console.log("Watching client source files…");
} else {
  await Promise.all([build(appOptions), build(workerOptions)]);
}
