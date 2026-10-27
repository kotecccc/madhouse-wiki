import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const DEFAULT_DIRECTORY = resolve("scripts/bridge/protocol-v1");

export function verifyProtocolPin(directory = DEFAULT_DIRECTORY) {
  let manifest;
  try {
    manifest = JSON.parse(
      readFileSync(join(directory, "protocol-source.json"), "utf8"),
    );
  } catch {
    throw new Error("bridge_protocol_pin_invalid");
  }
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    Object.keys(manifest).length !== 4 ||
    manifest.package !== "@madhouse/bridge-protocol" ||
    typeof manifest.version !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(manifest.version) ||
    !/^[a-f0-9]{64}$/u.test(manifest.sourceTreeSha256 || "") ||
    !Array.isArray(manifest.files) ||
    manifest.files.length < 1 ||
    manifest.files.some(
      (name, index) =>
        typeof name !== "string" ||
        basename(name) !== name ||
        !name.endsWith(".mjs") ||
        manifest.files.indexOf(name) !== index,
    )
  )
    throw new Error("bridge_protocol_pin_invalid");

  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".mjs"))
    .sort();
  if (JSON.stringify(files) !== JSON.stringify([...manifest.files].sort()))
    throw new Error("bridge_protocol_pin_invalid");

  const digest = createHash("sha256");
  for (const name of files) {
    let contents;
    try {
      contents = readFileSync(join(directory, name));
    } catch {
      throw new Error("bridge_protocol_pin_invalid");
    }
    digest.update(name).update("\0").update(contents).update("\0");
  }
  if (digest.digest("hex") !== manifest.sourceTreeSha256)
    throw new Error("bridge_protocol_pin_invalid");

  return {
    package: manifest.package,
    version: manifest.version,
    sourceTreeSha256: manifest.sourceTreeSha256,
    files,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  const pin = verifyProtocolPin();
  process.stdout.write(
    `Verified ${pin.package}@${pin.version} source tree ${pin.sourceTreeSha256}\n`,
  );
}
