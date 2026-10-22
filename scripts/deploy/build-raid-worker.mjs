import { mkdir, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const output = resolve(
  process.env.MADHOUSE_WORKER_OUTPUT || ".vercel/raid-worker",
);
await mkdir(output, { recursive: true });
await build({
  entryPoints: ["scripts/telegram/raid-live-worker.mjs"],
  outfile: resolve(output, "worker.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
const wasm = resolve(output, "node_modules/@mtcute/wasm");
await mkdir(wasm, { recursive: true });
for (const filename of ["mtcute.wasm", "mtcute-simd.wasm"])
  await copyFile(
    resolve("node_modules/@mtcute/wasm", filename),
    resolve(wasm, filename),
  );
console.log("Raid worker bundle prepared:", output);
