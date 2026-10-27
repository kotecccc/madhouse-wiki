import { restoreAutomationStateArchive } from "./state-backup.mjs";

function targetDirectory(args) {
  if (args.length !== 2 || args[0] !== "--directory" || !args[1])
    throw new Error(
      "usage: restore-state.mjs --directory <empty-state-directory>",
    );
  return args[1];
}

async function main() {
  if (process.stdin.isTTY)
    throw new Error("automation_restore_requires_decrypted_pipe");
  const directory = targetDirectory(process.argv.slice(2));
  const result = await restoreAutomationStateArchive({
    input: process.stdin,
    directory,
  });
  process.stdout.write(
    `Restored SQLite snapshot (${result.databaseBytes} bytes, created ${new Date(result.createdAt).toISOString()}). Account reauthorization is required before game mutations.\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error?.message?.startsWith("usage:") ? error.message : "automation_restore_failed; discard this empty target volume and retry"}\n`,
  );
  process.exitCode = 1;
});
