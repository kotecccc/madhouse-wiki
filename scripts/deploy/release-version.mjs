import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (name) =>
  JSON.parse(readFileSync(new URL(`../../${name}`, import.meta.url), "utf8"));

export function validateReleaseVersion(
  manifest,
  lock,
  changelog,
  previousVersion,
) {
  const version = manifest?.version;
  const match =
    typeof version === "string" &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) throw new Error("Invalid application version");
  if (lock?.version !== version || lock?.packages?.[""]?.version !== version)
    throw new Error("Package and lockfile versions differ");
  const latest = changelog?.[0];
  if (
    latest?.version !== version ||
    !/^\d{4}-\d{2}-\d{2}$/.test(latest.date ?? "") ||
    !Array.isArray(latest.changes) ||
    !latest.changes.length ||
    latest.changes.some((item) => typeof item !== "string" || !item.trim())
  )
    throw new Error(
      "Latest changelog entry must match the version and contain a date and changes",
    );
  if (previousVersion !== undefined) {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(previousVersion))
      throw new Error("Invalid previous release version");
    const previous = previousVersion.split(".").map(BigInt);
    const current = version.split(".").map(BigInt);
    const firstDifference = current.findIndex(
      (part, index) => part !== previous[index],
    );
    if (
      firstDifference === -1 ||
      current[firstDifference] < previous[firstDifference]
    )
      throw new Error(
        "Application version must increase from the previous release",
      );
  }
  return version;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const version = validateReleaseVersion(
      read("package.json"),
      read("package-lock.json"),
      read("changelog.json"),
      process.argv[2],
    );
    process.stdout.write(`Release version ${version} is valid\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
