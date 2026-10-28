import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { connect as connectTls } from "node:tls";
import { test } from "node:test";
import { createBridgeAccountService } from "../../scripts/bridge/account-service.mjs";
import { createBridgeAccountStore } from "../../scripts/bridge/account-store.mjs";
import { createBridgeDeviceHttp } from "../../scripts/bridge/device-http.mjs";
import { createGameRouter } from "../../scripts/bridge/game-router.mjs";
import { createVerifiedRouteResolver } from "../../scripts/bridge/verified-route-resolver.mjs";
import { createDeviceGateway } from "../../scripts/bridge/device-gateway.mjs";
import { createDeviceRegistry } from "../../scripts/bridge/device-registry.mjs";
import { createBridgeDeviceService } from "../../scripts/bridge/device-service.mjs";
import { readProfileOverBridge } from "../../scripts/bridge/profile-client.mjs";
import { createGameTlsDuplexConnector } from "../../scripts/bridge/tls-duplex-connector.mjs";

const agentPath = process.env.MADHOUSE_FAKE_AGENT_PATH;
const cargoCert = await readFile(
  new URL("./fixtures/cargo-cert.pem", import.meta.url),
);
const cargoKey = await readFile(
  new URL("./fixtures/cargo-key.pem", import.meta.url),
);

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));

// Cross-repository fixture is opt-in: never connect to game or production gateway.
test(
  "Wiki obtains a fake profile over WSS and the separate Python agent",
  { skip: !agentPath, timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-integration-"));
    const certPath = join(directory, "gateway-cert.pem");
    const keyPath = join(directory, "gateway-key.pem");
    const made = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-subj",
        "/CN=fake-game.test",
        "-addext",
        "subjectAltName=DNS:fake-game.test,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    assert.equal(made.status, 0);
    let requests = 0;
    let started;
    const secondStarted = new Promise((resolve) => {
      started = resolve;
    });
    const game = createHttpServer(
      { cert: cargoCert, key: cargoKey },
      (req, res) => {
        assert.equal(req.url, "/api/me");
        assert.equal(req.headers.authorization, "Bearer synthetic-token");
        requests += 1;
        if (requests === 4) {
          started();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"playerId":42,"telegramId":101}');
      },
    );
    await listen(game);
    const gateway = createHttpServer({
      cert: await readFile(certPath),
      key: await readFile(keyPath),
    });
    const database = new DatabaseSync(":memory:");
    const hmacKey = randomBytes(32);
    const registry = createDeviceRegistry({ db: database, hmacKey });
    const accounts = createBridgeAccountStore({
      db: database,
      hmacKey,
      registry,
    });
    const service = createBridgeDeviceService({ registry });
    const device = service.redeemInvitation(
      service.issueInvitation("101").invitation,
    );
    const token = `${device.deviceId}.${device.deviceKey}`;
    const wire = [];
    const observingService = {
      admit: async (identity, ws) => {
        ws.on("message", (bytes) => wire.push(Buffer.from(bytes)));
        const send = ws.send.bind(ws);
        ws.send = (bytes, ...args) => {
          wire.push(Buffer.from(bytes));
          return send(bytes, ...args);
        };
        return service.admit(identity, ws);
      },
    };
    const deviceGateway = createDeviceGateway({
      service: observingService,
      registry,
      consume: () => true,
      heartbeatMs: 1000,
    });
    gateway.on(
      "upgrade",
      (req, socket, head) =>
        void deviceGateway.upgrade(req, socket, head, "127.0.0.1"),
    );
    await listen(gateway);
    const openWhenReady = async () => {
      for (let attempt = 0; attempt < 150; attempt += 1) {
        try {
          return await service.open("101");
        } catch (error) {
          if (error.code !== "bridge_offline") throw error;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      throw new Error("test_agent_did_not_connect");
    };
    const agent = spawn(
      "python3",
      [
        agentPath,
        "--gateway-port",
        String(gateway.address().port),
        "--target-port",
        String(game.address().port),
        "--ca",
        certPath,
        "--token",
        token,
      ],
      { stdio: "ignore" },
    );
    try {
      // Keep the connection idle through two gateway heartbeat intervals.
      await new Promise((resolve) => setTimeout(resolve, 2200));
      const accountService = createBridgeAccountService({
        accounts,
        devices: service,
        registry,
        readProfile: (options) =>
          readProfileOverBridge({
            ...options,
            connector: createGameTlsDuplexConnector({
              openTunnel: openWhenReady,
              validateTunnel: options.validateTunnel,
              tlsConnect: (tlsOptions) =>
                connectTls({ ...tlsOptions, ca: cargoCert }),
            }),
          }),
      });
      const now = 1_800_000_000_000;
      const botToken = "synthetic-bot";
      const init = new URLSearchParams({
        auth_date: String(now / 1000),
        user: JSON.stringify({ id: 101 }),
      });
      const signed = [...init.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");
      const secret = createHmac("sha256", "WebAppData")
        .update(botToken)
        .digest();
      init.set(
        "hash",
        createHmac("sha256", secret).update(signed).digest("hex"),
      );
      const http = createBridgeDeviceHttp({
        service,
        accountService,
        botToken,
        origin: "https://wiki.example",
        now: () => now,
        consume: () => true,
      });
      const result = await http(
        new Request("https://wiki.example/api/bridge/device", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://wiki.example",
          },
          body: JSON.stringify({
            operation: "bind",
            initData: init.toString(),
            accessToken: "synthetic-token",
          }),
        }),
        "127.0.0.1",
      );
      assert.equal(result.status, 200);
      assert.deepEqual(await result.json(), { status: "connected" });
      assert.deepEqual(accounts.read("101"), {
        playerId: "42",
        authorization: "Bearer synthetic-token",
        revision: 1,
      });
      const profile = await http(
        new Request("https://wiki.example/api/bridge/device", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://wiki.example",
          },
          body: JSON.stringify({
            operation: "profile",
            initData: init.toString(),
          }),
        }),
        "127.0.0.1",
      );
      assert.equal(profile.status, 200);
      assert.deepEqual(await profile.json(), {
        profile: { playerId: 42, telegramId: 101 },
      });
      assert.equal(
        Buffer.concat(wire).includes(Buffer.from("synthetic-token")),
        false,
      );
      const router = createGameRouter({
        resolveRoute: createVerifiedRouteResolver({ accounts }),
        directFetch: () =>
          assert.fail("bridge route must never use direct network"),
        bridgeProfile: (owner, options) =>
          accountService.profile(owner, options),
      });
      const routed = await router.fetchGame({
        url: "https://cargohustle.online/api/me",
        verifiedIdentity: { playerId: "42" },
      });
      assert.deepEqual(routed, { profile: { playerId: 42, telegramId: 101 } });
      const connector2 = createGameTlsDuplexConnector({
        openTunnel: openWhenReady,
        tlsConnect: (options) => connectTls({ ...options, ca: cargoCert }),
      });
      const interrupted = readProfileOverBridge({
        authorization: "Bearer synthetic-token",
        connector: connector2,
      }).then(
        () => false,
        () => true,
      );
      await secondStarted;
      service.revoke("101", device.deviceId);
      assert.equal(await interrupted, true);
      assert.equal(requests, 4);
    } finally {
      agent.kill();
      service.close();
      database.close();
      deviceGateway.close();
      await Promise.all([close(gateway), close(game)]);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
