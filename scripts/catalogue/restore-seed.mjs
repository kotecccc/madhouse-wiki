import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = new URL("../../", import.meta.url);
const destination = fileURLToPath(new URL("local-data/madhouse.sqlite", root));
// The canonical local catalogue always wins. A clean checkout restores the
// audited release seed, then uses the exact same SQL query/Vite pipeline.
if (!existsSync(destination)) {
  mkdirSync(fileURLToPath(new URL("local-data/", root)), { recursive: true });
  copyFileSync(new URL("catalogue/reference.sqlite", root), destination);
}
