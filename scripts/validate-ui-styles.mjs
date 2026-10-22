import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// UI primitives define the kit. Application styles may compose it, never invent values.
const roots = ["src", "connector/src"];
const failures = [];
const definitions = await readFile("src/styles/tokens.css", "utf8");
const tokens = new Set(
  [...definitions.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]),
);
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(file);
    else if (file.endsWith(".css")) {
      const source = await readFile(file, "utf8");
      const kit =
        file.startsWith("src/components/ui/") || file.startsWith("src/styles/");
      for (const [index, line] of source.split("\n").entries()) {
        const fail = (reason) =>
          failures.push(`${file}:${index + 1}: ${reason}`);
        if (!kit && /!important/.test(line))
          fail("Feature styles cannot override the UI Kit with !important");
        if (!kit && /(?:#[\da-f]{3,8}\b|rgba?\(|hsla?\()/i.test(line))
          fail("Use an existing UI Kit color token");
        if (
          file !== "src/styles/global.css" &&
          /^\s*(?:--card-(?:title-size|description-size|content-gap|padding)|font-size|(?:row-|column-)?gap|padding(?:-[\w]+)?|margin(?:-[\w]+)?|border-radius)\s*:/.test(
            line,
          ) &&
          /\b[1-9][\d.]*(?:px|rem|em)\b/.test(line)
        )
          fail("Use an existing UI Kit size or spacing token");
        for (const match of line.matchAll(
          /var\((--(?:space|font-size)-[\w-]+)/g,
        )) {
          if (!tokens.has(match[1])) fail(`Undefined design token ${match[1]}`);
        }
      }
    }
  }
}
for (const root of roots) await visit(root);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    "UI style policy: no arbitrary typography, spacing, feature colors or undefined scale tokens.",
  );
