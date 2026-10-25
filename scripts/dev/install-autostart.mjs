import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

if (process.platform !== "darwin")
  throw new Error("This login setup requires macOS.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const label = "com.madhouse-wiki.dev";
const agents = resolve(homedir(), "Library/LaunchAgents");
const logs = resolve(homedir(), "Library/Logs");
const plist = resolve(agents, `${label}.plist`);
const xml = (s) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
await mkdir(agents, { recursive: true });
await mkdir(logs, { recursive: true });
await writeFile(
  plist,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>/bin/sh</string><string>${xml(resolve(root, "scripts/dev/start-docker.sh"))}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(resolve(logs, "madhouse-wiki-dev.log"))}</string>
<key>StandardErrorPath</key><string>${xml(resolve(logs, "madhouse-wiki-dev-error.log"))}</string>
</dict></plist>
`,
  { mode: 0o600 },
);
const domain = `gui/${process.getuid()}`;
spawnSync("launchctl", ["bootout", `${domain}/${label}`], { stdio: "ignore" });
const result = spawnSync("launchctl", ["bootstrap", domain, plist], {
  stdio: "inherit",
});
if (result.status !== 0)
  throw new Error("Could not register the login service.");
console.log(`Installed login startup: ${plist}`);
