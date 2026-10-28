import { createHmac, randomBytes } from "node:crypto";
import {
  constants,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDeviceRegistry } from "./device-registry.mjs";
import { createBridgeAccountStore } from "./account-store.mjs";
import { createDirectRouteLeases } from "./direct-route-leases.mjs";
import { createConnectorOwnerLeases } from "./connector-owner-leases.mjs";
import { createConnectorNonceStore } from "./connector-lease-ipc.mjs";
import { createDirectCredentialStore } from "./direct-credential-store.mjs";
import { createRouteWitness } from "./route-witness.mjs";

function checkPrivateFile(path, length = null) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    )
      throw new Error("bridge_storage_permissions_invalid");
    const data = length === null ? null : readFileSync(fd);
    if (data && data.length !== length)
      throw new Error("bridge_storage_key_invalid");
    return data;
  } finally {
    closeSync(fd);
  }
}

function createPrivateFile(path, contents) {
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (contents) writeFileSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** A dedicated private local store; not a substitute for backup or key rotation. */
export function createBridgeStorage({
  directory,
  now,
  witnessPath,
  provisionWitness = false,
} = {}) {
  if (typeof directory !== "string" || !directory)
    throw new TypeError("bridge_storage_directory_required");
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    throw new Error("bridge_storage_directory_invalid");
  const keyPath = join(root, "device-hmac.key");
  const databasePath = join(root, "devices.sqlite");
  if (
    witnessPath &&
    (resolve(witnessPath) === root ||
      resolve(witnessPath).startsWith(root + "/"))
  )
    throw new Error("route_witness_must_be_separate");
  if (provisionWitness && (!witnessPath || existsSync(databasePath)))
    throw new Error("route_witness_provision_requires_fresh_storage");
  // Losing either half of an existing registry must not silently reset identity.
  if (existsSync(keyPath) !== existsSync(databasePath))
    throw new Error("bridge_storage_incomplete");
  if (!existsSync(keyPath)) {
    try {
      createPrivateFile(keyPath, randomBytes(32));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  const key = checkPrivateFile(keyPath, 32);
  if (!existsSync(databasePath)) {
    try {
      createPrivateFile(databasePath);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  checkPrivateFile(databasePath);
  const witness = witnessPath
    ? createRouteWitness({
        path: resolve(witnessPath),
        provision: provisionWitness,
        keyFingerprint: createHmac("sha256", key)
          .update("bridge-route-witness-key-v1")
          .digest("hex"),
      })
    : null;
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
    chmodSync(databasePath, 0o600);
    const registry = createDeviceRegistry({
      db,
      hmacKey: key,
      routeWitness: witness,
      ...(now ? { now } : {}),
    });
    const accounts = createBridgeAccountStore({
      db,
      hmacKey: key,
      registry,
      routeWitness: witness,
    });
    const directRoutes = createDirectRouteLeases({
      db,
      accounts,
      registry,
      routeWitness: witness,
    });
    const directCredentials = createDirectCredentialStore({
      db,
      hmacKey: key,
      registry,
      accounts,
      routeWitness: witness,
    });
    const connectorLeases = createConnectorOwnerLeases({
      db,
      registry,
      routeWitness: witness,
    });
    const consumeConnectorNonce = createConnectorNonceStore(db, witness);
    key.fill(0);
    return Object.freeze({
      registry,
      accounts,
      directRoutes,
      directCredentials,
      connectorLeases,
      consumeConnectorNonce,
      close: () => {
        db.close();
        witness?.close();
      },
    });
  } catch (error) {
    key.fill(0);
    db.close();
    witness?.close();
    throw error;
  }
}
