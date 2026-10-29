import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import WebSocket from "ws";
import { createVpsBridgeLab } from "../../scripts/bridge/vps-lab.mjs";
import { createBridgeStorage } from "../../scripts/bridge/device-storage.mjs";

const key = "ab".repeat(32);
const botToken = "fake-bot";
const wikiOrigin = "https://wiki.test";
const connectorOrigin = "https://connector.test";

function signedIdentity() {
  const data = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: 101 }),
  });
  const check = [...data.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  data.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return data.toString();
}

test("bridge lab is disabled by default and refuses public origins", () => {
  assert.equal(
    createVpsBridgeLab({ role: "wiki", env: {}, wikiOrigin, connectorOrigin }),
    null,
  );
  assert.throws(
    () =>
      createVpsBridgeLab({
        role: "wiki",
        env: { MADHOUSE_BRIDGE_LAB: "1", MADHOUSE_BRIDGE_IPC_KEY: key },
        wikiOrigin: "https://madhouse-wiki.ru",
        connectorOrigin,
      }),
    { message: "bridge_lab_origin_forbidden" },
  );
  assert.throws(
    () =>
      createVpsBridgeLab({
        role: "connector",
        env: { MADHOUSE_BRIDGE_LAB: "1" },
        wikiOrigin,
        connectorOrigin,
      }),
    { message: "bridge_lab_key_required" },
  );
});

test("production bridge requires an explicit, unambiguous mode and exact origins", () => {
  const productionOrigins = {
    wikiOrigin: "https://madhouse-wiki.ru",
    connectorOrigin: "https://connect.madhouse-wiki.ru",
  };
  const env = {
    MADHOUSE_BRIDGE_PRODUCTION: "1",
    MADHOUSE_BRIDGE_IPC_KEY: key,
    WIKI_INITDATA_KEY: key,
  };
  assert.ok(
    createVpsBridgeLab({ role: "connector", env, ...productionOrigins }).guard,
  );
  assert.throws(
    () =>
      createVpsBridgeLab({
        role: "connector",
        env,
        ...productionOrigins,
        wikiOrigin,
      }),
    { message: "bridge_lab_origin_forbidden" },
  );
  assert.throws(
    () =>
      createVpsBridgeLab({
        role: "connector",
        env: { ...env, MADHOUSE_BRIDGE_LAB: "1" },
        ...productionOrigins,
      }),
    { message: "bridge_lab_configuration_invalid" },
  );
  assert.throws(
    () =>
      createVpsBridgeLab({
        role: "connector",
        env: { ...env, MADHOUSE_BRIDGE_IPC_KEY: "" },
        ...productionOrigins,
      }),
    { message: "bridge_lab_key_required" },
  );
  assert.throws(
    () => createVpsBridgeLab({ role: "wiki", env, ...productionOrigins }),
    { message: "bridge_lab_storage_required" },
  );
});

test("production bridge reopens its provisioned private storage after restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-production-config-"));
  const options = {
    role: "wiki",
    wikiOrigin: "https://madhouse-wiki.ru",
    connectorOrigin: "https://connect.madhouse-wiki.ru",
    env: {
      MADHOUSE_BRIDGE_PRODUCTION: "1",
      MADHOUSE_BRIDGE_IPC_KEY: key,
      MADHOUSE_BRIDGE_STATE_DIR: join(directory, "state"),
      MADHOUSE_BRIDGE_WITNESS_PATH: join(directory, "witness.sqlite"),
      MADHOUSE_BRIDGE_PROVISION_WITNESS: "1",
      TELEGRAM_BOT_TOKEN: botToken,
    },
  };
  try {
    const first = createVpsBridgeLab(options);
    first.privateServer.close();
    first.runtime.close();
    const second = createVpsBridgeLab({
      ...options,
      env: { ...options.env, MADHOUSE_BRIDGE_PROVISION_WITNESS: "0" },
    });
    assert.ok(second.runtime && second.privateServer);
    second.privateServer.close();
    second.runtime.close();
    assert.throws(() => createVpsBridgeLab(options), {
      message: "route_witness_provision_requires_fresh_storage",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("recovery-only keeps private owner admission and stored route policy without public bridge endpoints", () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-recovery-only-"));
  const state = join(directory, "state");
  const witness = join(directory, "witness.sqlite");
  const base = {
    MADHOUSE_BRIDGE_IPC_KEY: key,
    WIKI_INITDATA_KEY: key,
    MADHOUSE_BRIDGE_STATE_DIR: state,
    MADHOUSE_BRIDGE_WITNESS_PATH: witness,
    TELEGRAM_BOT_TOKEN: botToken,
  };
  let recovery;
  try {
    assert.throws(
      () =>
        createVpsBridgeLab({
          role: "wiki",
          env: { ...base, MADHOUSE_BRIDGE_RECOVERY_ONLY: "1" },
          wikiOrigin,
          connectorOrigin,
        }),
      { message: "bridge_recovery_storage_required" },
    );
    const initial = createVpsBridgeLab({
      role: "wiki",
      env: {
        ...base,
        MADHOUSE_BRIDGE_LAB: "1",
        MADHOUSE_BRIDGE_PROVISION_WITNESS: "1",
      },
      wikiOrigin,
      connectorOrigin,
    });
    initial.privateServer.close();
    initial.runtime.close();
    const storage = createBridgeStorage({
      directory: state,
      witnessPath: witness,
    });
    const lease = storage.connectorLeases.acquire("101", "telegram_auth");
    storage.connectorLeases.markDispatched("101", lease);
    storage.close();
    const env = { ...base, MADHOUSE_BRIDGE_RECOVERY_ONLY: "1" };
    recovery = createVpsBridgeLab({
      role: "wiki",
      env,
      wikiOrigin,
      connectorOrigin,
    });
    assert.equal(recovery.adapter, null);
    assert.ok(recovery.privateServer);
    assert.equal(
      recovery.runtime.bootstrapPolicy.canClaim(
        "101",
        lease,
        "telegram_auth",
        1,
        null,
      ),
      true,
    );
    assert.ok(
      createVpsBridgeLab({
        role: "connector",
        env,
        wikiOrigin,
        connectorOrigin,
      }).guard,
    );
    assert.throws(
      () =>
        createVpsBridgeLab({
          role: "wiki",
          env: { ...env, MADHOUSE_BRIDGE_PROVISION_WITNESS: "1" },
          wikiOrigin,
          connectorOrigin,
        }),
      { message: "bridge_recovery_storage_required" },
    );
  } finally {
    recovery?.privateServer.close();
    recovery?.runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "VPS test mode exposes paired HTTP and WebSocket routes",
  { timeout: 15000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "bridge-vps-lab-"));
    const releaseDir = join(directory, "release");
    mkdirSync(releaseDir);
    writeFileSync(join(releaseDir, "bootstrap.pyz"), "synthetic bootstrap");
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const env = {
      ...process.env,
      MADHOUSE_RELEASE_SHA: "0".repeat(40),
      ACCOUNT_SESSION_KEY: "a".repeat(64),
      WIKI_SESSION_KEY: "b".repeat(64),
      MADHOUSE_GAME_EXECUTOR_KEY: "c".repeat(64),
      MADHOUSE_STORAGE_ORIGIN: "https://storage.example.test",
      MADHOUSE_STORAGE_TOKEN: "t".repeat(32),
      PORT: String(port),
      WIKI_PUBLIC_ORIGIN: wikiOrigin,
      CONNECTOR_PUBLIC_ORIGIN: connectorOrigin,
      MADHOUSE_AUTOMATION_GAME_ENABLED: "0",
      MADHOUSE_AUTOMATION_STATE_DIR: join(directory, "automation"),
      MADHOUSE_VPS_INLINE_CARDS: "0",
      MADHOUSE_BRIDGE_LAB: "1",
      MADHOUSE_BRIDGE_IPC_KEY: key,
      MADHOUSE_BRIDGE_STATE_DIR: join(directory, "bridge"),
      MADHOUSE_BRIDGE_WITNESS_PATH: join(directory, "witness.sqlite"),
      MADHOUSE_BRIDGE_RELEASE_DIR: releaseDir,
      MADHOUSE_BRIDGE_PROVISION_WITNESS: "1",
      TELEGRAM_BOT_TOKEN: botToken,
    };
    const child = spawn(
      process.execPath,
      ["scripts/deploy/vps-server.mjs", "wiki"],
      { env, stdio: "ignore" },
    );
    const base = `http://127.0.0.1:${port}`;
    let socket;
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null) throw new Error("VPS lab exited");
        try {
          if ((await fetch(base + "/healthz")).ok) {
            ready = true;
            break;
          }
        } catch {
          /* starting */
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      assert.ok(ready);
      const bootstrap = await fetch(base + "/bridge/bootstrap.pyz");
      assert.equal(bootstrap.status, 200);
      assert.equal(await bootstrap.text(), "synthetic bootstrap");
      const post = (path, body) =>
        fetch(base + path, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: wikiOrigin },
          body: JSON.stringify(body),
        });
      const invited = await post("/api/bridge/device", {
        operation: "invite",
        initData: signedIdentity(),
      });
      assert.equal(invited.status, 200);
      const invitation = await invited.json();
      const redeemed = await post("/api/bridge/redeem", {
        invitation: invitation.invitation,
      });
      assert.equal(redeemed.status, 200);
      const device = await redeemed.json();
      socket = new WebSocket(`ws://127.0.0.1:${port}/bridge/data`, {
        headers: {
          Authorization: `MadhouseBridge ${device.deviceId}.${device.deviceKey}`,
        },
      });
      await new Promise((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      const status = await post("/api/bridge/device", {
        operation: "status",
        initData: signedIdentity(),
      });
      assert.equal((await status.json()).device, "online");
    } finally {
      socket?.terminate();
      child.kill("SIGTERM");
      await new Promise((resolve) =>
        child.exitCode !== null ? resolve() : child.once("exit", resolve),
      );
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
