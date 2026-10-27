import { fstatSync, lstatSync, statfsSync } from "node:fs";
import { writeAutomationStateArchive } from "./state-backup.mjs";

async function main() {
  const directory = process.env.MADHOUSE_AUTOMATION_STATE_DIR;
  const temporaryDirectory = process.env.MADHOUSE_AUTOMATION_SNAPSHOT_TMPDIR;
  if (!directory || !temporaryDirectory || process.stdout.isTTY)
    throw new Error("automation_backup_requires_encrypted_pipe");
  const outputStat = fstatSync(1);
  const temporaryStat = lstatSync(temporaryDirectory);
  if (!outputStat.isFIFO())
    throw new Error("automation_backup_requires_encrypted_pipe");
  if (
    !temporaryStat.isDirectory() ||
    temporaryStat.isSymbolicLink() ||
    (temporaryStat.mode & 0o077) !== 0 ||
    process.platform !== "linux" ||
    statfsSync(temporaryDirectory).type !== 0x01021994
  )
    throw new Error("automation_backup_requires_private_tmpfs");
  await writeAutomationStateArchive({
    directory,
    temporaryDirectory,
    output: process.stdout,
  });
}

main().catch((error) => {
  const message = [
    "automation_backup_requires_encrypted_pipe",
    "automation_backup_requires_private_tmpfs",
  ].includes(error?.message)
    ? error.message
    : "automation_backup_failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
