import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const SOURCE_ROOTS = ["api", "connector", "scripts", "src"];
const ROOT_FILES = ["vite.config.js"];
const CARGO_ORIGIN_REFERENCE = /https:\/\/cargohustle\.online/;
const reviewedReferences = new Set([
  "connector/account-session.js",
  "connector/game-auth-api.js",
  "connector/session.js",
  "scripts/account/boss-cards.mjs",
  "scripts/account/boss-cards.test.mjs",
  "scripts/account/player-progress.mjs",
  "scripts/account/player-progress.test.mjs",
  "scripts/account/snapshots.mjs",
  "scripts/account/snapshots.test.mjs",
  "scripts/catalogue/importer.test.mjs",
  "scripts/automation/inventory-actions.mjs",
  "scripts/automation/buddy-booster.mjs",
  "scripts/automation/buddy-stash.mjs",
  "scripts/automation/friend-removal.mjs",
  "scripts/automation/raid-friends.mjs",
  "scripts/automation/service.mjs",
  "scripts/automation/weapon-equipment.mjs",
  "scripts/bridge/game-api-client.mjs",
  "scripts/bridge/game-api-transport.mjs",
  "scripts/bridge/tls-duplex-connector.mjs",
  "scripts/catalogue/importer.mjs",
  "scripts/deploy/production-api.mjs",
  "scripts/telegram/prove-game-auth.mjs",
  "scripts/telegram/prove-game-auth.test.mjs",
  "src/components/layout/BottomDock/GameHealthWarning.jsx",
  "src/features/auth/LoginControl/LoginControl.jsx",
  "src/features/auth/profile.js",
  "src/features/businesses/BusinessItemTile/BusinessItemTile.jsx",
  "src/features/auth/LoginControl/token-bookmarklet.js",
  "vite.config.js",
]);

function collect(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return ["dist", "node_modules", ".git"].includes(entry.name)
        ? []
        : collect(path);
    if (!/\.(?:js|jsx|mjs|ts|tsx)$/u.test(entry.name)) return [];
    return [path];
  });
}

const files = [
  ...SOURCE_ROOTS.flatMap((directory) => collect(directory)),
  ...ROOT_FILES,
];
const references = new Set(
  files
    .filter((path) => CARGO_ORIGIN_REFERENCE.test(readFileSync(path, "utf8")))
    .map((path) => relative(process.cwd(), path)),
);
const unexpected = [...references].filter(
  (path) => !reviewedReferences.has(path),
);
if (unexpected.length) {
  throw new Error(
    `Unreviewed Cargo-origin source reference(s): ${unexpected.sort().join(", ")}`,
  );
}

console.log(
  `Reviewed ${references.size} Cargo-origin source references; new call sites require route-boundary review.`,
);
