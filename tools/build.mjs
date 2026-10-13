// Builds dist/index.js with esbuild. React, Decky's UI library and the Decky loader API are taken from
// the globals Decky Loader provides inside Steam (window.SP_REACT, window.SP_JSX, window.DFL), exactly
// like the official @decky/rollup template does, so the output works the same way.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root); // keeps file comments in the bundle relative (no local paths)
const shims = {
  "react": "tools/shims/react.js",
  "react/jsx-runtime": "tools/shims/jsx.js",
  "@decky/ui": "tools/shims/ui.js",
  "@decky/api": "tools/shims/api.js",
};

await build({
  entryPoints: ["src/index.tsx"], bundle: true, format: "esm", target: "es2020",
  outfile: "dist/index.js", jsx: "automatic", charset: "utf8", logLevel: "warning",
  plugins: [{ name: "decky-globals", setup(b) {
    b.onResolve({ filter: /^(react|react\/jsx-runtime|@decky\/ui|@decky\/api)$/ }, (a) => ({ path: path.join(root, shims[a.path]) }));
  } }],
});

console.log("built dist/index.js");
