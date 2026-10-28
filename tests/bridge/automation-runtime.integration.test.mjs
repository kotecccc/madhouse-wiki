import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as connectTls } from "node:tls";
import { test } from "node:test";
import { createAutomationRuntime } from "../../scripts/automation/runtime.mjs";
import { createActionQueue } from "../../scripts/automation/action-queue.mjs";
import { createAccountQueue } from "../../scripts/automation/account-queue.mjs";
import { queuedFriendResponseAdapter } from "../../scripts/automation/queued-friend-response.mjs";
import { createBridgeRuntime } from "../../scripts/bridge/runtime.mjs";
import { createBridgeNodeAdapter } from "../../scripts/bridge/node-adapter.mjs";
import {
  readGameOverBridge,
  readProfileOverBridge,
  sendFriendResponseOverBridge,
  sendWorkTaskOverBridge,
} from "../../scripts/bridge/profile-client.mjs";
import { createWorkActionPermit } from "../../scripts/bridge/work-action-permit.mjs";
import { createGameTlsDuplexConnector } from "../../scripts/bridge/tls-duplex-connector.mjs";

const agentPath = process.env.MADHOUSE_FAKE_AGENT_PATH;
const cert = await readFile(
  new URL("./fixtures/cargo-cert.pem", import.meta.url),
);
const key = await readFile(
  new URL("./fixtures/cargo-key.pem", import.meta.url),
);
const origin = "https://wiki.example";
const botToken = "fake-bot";
const now = 1_800_000_000_000;
const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));
function initData() {
  const data = new URLSearchParams({
    auth_date: String(now / 1000),
    user: JSON.stringify({ id: 101 }),
  });
  const input = [...data.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  data.set("hash", createHmac("sha256", secret).update(input).digest("hex"));
  return data.toString();
}

test(
  "Wiki runtime proxy routes a bound profile through the Python agent and fails closed offline",
  { skip: !agentPath, timeout: 20000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-runtime-e2e-"));
    const ca = join(root, "gateway-cert.pem");
    const caKey = join(root, "gateway-key.pem");
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
        caKey,
        "-out",
        ca,
        "-subj",
        "/CN=fake-game.test",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    assert.equal(made.status, 0);
    let requests = 0;
    let sends = 0;
    let accepted = false;
    const game = createHttpsServer({ cert, key }, (request, response) => {
      requests += 1;
      const path = new URL(request.url, "https://game.test").pathname;
      assert.ok(
        [
          "/api/me",
          "/api/friends",
          "/api/friends/requests/incoming",
          "/api/friends/requests/outgoing",
          "/api/friends/requests/42/accept",
          "/api/works/open",
          "/api/works/tasks/perform",
        ].includes(path),
      );
      assert.equal(request.headers.authorization, "Bearer synthetic-token");
      if (path === "/api/works/tasks/perform") {
        sends++;
        request.resume();
        request.once("end", () => request.socket.destroy());
        return;
      }
      if (path.endsWith("/accept")) {
        sends++;
        accepted = true;
        request.resume();
        request.once("end", () => request.socket.destroy());
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        path === "/api/me"
          ? '{"playerId":42,"telegramId":101,"nickname":"fake"}'
          : JSON.stringify({
              items:
                (path === "/api/friends" && accepted) ||
                (path === "/api/friends/requests/incoming" && !accepted)
                  ? [{ player: { playerId: 42 } }]
                  : [],
              nextCursor: null,
            }),
      );
    });
    await listen(game);
    const bridge = createBridgeRuntime({
      directory: join(root, "bridge"),
      witnessPath: join(root, "witness.sqlite"),
      provisionWitness: true,
      botToken,
      origin,
      now: () => now,
      consume: () => true,
      readProfile: (options) =>
        readProfileOverBridge({
          ...options,
          connector: createGameTlsDuplexConnector({
            openTunnel: options.openTunnel,
            validateTunnel: options.validateTunnel,
            tlsConnect: (tlsOptions) => connectTls({ ...tlsOptions, ca: cert }),
          }),
        }),
      readGame: (options) =>
        readGameOverBridge({
          ...options,
          connector: createGameTlsDuplexConnector({
            openTunnel: options.openTunnel,
            validateTunnel: options.validateTunnel,
            tlsConnect: (tlsOptions) => connectTls({ ...tlsOptions, ca: cert }),
          }),
        }),
      sendAction: (options) =>
        sendFriendResponseOverBridge({
          ...options,
          connector: createGameTlsDuplexConnector({
            openTunnel: options.openTunnel,
            validateTunnel: options.validateTunnel,
            tlsConnect: (tlsOptions) => connectTls({ ...tlsOptions, ca: cert }),
          }),
        }),
      sendWork: (options) =>
        sendWorkTaskOverBridge({
          ...options,
          connector: createGameTlsDuplexConnector({
            openTunnel: options.openTunnel,
            validateTunnel: options.validateTunnel,
            tlsConnect: (tlsOptions) => connectTls({ ...tlsOptions, ca: cert }),
          }),
        }),
    });
    const gateway = createHttpsServer({
      cert: await readFile(ca),
      key: await readFile(caKey),
    });
    const adapter = createBridgeNodeAdapter({ runtime: bridge, origin });
    gateway.on("upgrade", adapter.upgrade);
    await listen(gateway);
    const management = createHttpServer(adapter.handle);
    await listen(management);
    const automation = await createAutomationRuntime({
      bridge,
      env: {
        MADHOUSE_AUTOMATION_STATE_DIR: join(root, "automation"),
        MADHOUSE_AUTOMATION_GAME_ENABLED: "0",
        WIKI_PUBLIC_ORIGIN: origin,
      },
    });
    const proxy = createHttpServer(
      (request, response) => void automation.proxy(request, response),
    );
    await listen(proxy);
    const command = (operation, fields = {}) =>
      fetch(`http://127.0.0.1:${management.address().port}/api/bridge/device`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ operation, initData: initData(), ...fields }),
      });
    let agent;
    try {
      const invitation = await (await command("invite")).json();
      const paired = await (
        await fetch(
          `http://127.0.0.1:${management.address().port}/api/bridge/redeem`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ invitation: invitation.invitation }),
          },
        )
      ).json();
      agent = spawn(
        "python3",
        [
          agentPath,
          "--gateway-port",
          String(gateway.address().port),
          "--target-port",
          String(game.address().port),
          "--ca",
          ca,
          "--token",
          `${paired.deviceId}.${paired.deviceKey}`,
        ],
        { stdio: "ignore" },
      );
      async function waitStatus(expected) {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const state = await (await command("status")).json();
          if (state.device === expected) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.fail(`device did not become ${expected}`);
      }
      await waitStatus("online");
      const bound = await command("bind", { accessToken: "synthetic-token" });
      assert.equal(bound.status, 200);
      const sessionResponse = await command("session");
      assert.equal(sessionResponse.status, 200);
      const { session } = await sessionResponse.json();
      assert.ok(session);
      // Allow the single-use data connection to close and the agent to reconnect.
      await waitStatus("offline");
      await waitStatus("online");
      const url = `http://127.0.0.1:${proxy.address().port}/api/me`;
      const response = await fetch(url, {
        headers: { Authorization: "Bearer synthetic-token" },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        playerId: 42,
        telegramId: 101,
        nickname: "fake",
      });
      // A second request can wait for a fresh tunnel without replaying the first.
      const next = await fetch(url, {
        headers: { Authorization: "Bearer synthetic-token" },
      });
      assert.equal(next.status, 200);
      assert.equal((await next.json()).playerId, 42);
      assert.equal(requests, 3);
      const restored = await fetch(url, {
        headers: { Authorization: `Bearer ${session}` },
      });
      assert.equal(restored.status, 200);
      assert.equal((await restored.json()).playerId, 42);
      const friends = await fetch(
        `http://127.0.0.1:${proxy.address().port}/api/friends`,
        {
          headers: { Authorization: "Bearer synthetic-token" },
        },
      );
      assert.equal(friends.status, 200);
      assert.deepEqual(await friends.json(), { items: [], nextCursor: null });
      assert.equal(requests, 5);
      const transport = bridge.wrapSnapshots({
        identity: () => null,
        fetch: () => assert.fail("unexpected direct fetch"),
        liveFetch: () => assert.fail("unexpected direct fetch"),
      });
      const workView = await transport.liveFetch(
        "https://cargohustle.online/api/works/open",
        {
          method: "POST",
          body: JSON.stringify({ workId: 7, locale: "ru" }),
          headers: { Authorization: "Bearer synthetic-token" },
        },
      );
      assert.equal(workView.status, 200);
      const actionUrl =
        "https://cargohustle.online/api/friends/requests/42/accept";
      const action = () =>
        transport.liveFetch(actionUrl, {
          method: "POST",
          body: "{}",
          headers: { Authorization: "Bearer synthetic-token" },
        });
      await assert.rejects(action());
      assert.equal(requests, 6);
      let saved = [];
      const authorization = "Bearer synthetic-token";
      const fetcher = createAccountQueue(transport.liveFetch, {
        captureDispatchContext: bridge.queueActionGate.capture,
      });
      const responseAdapter = queuedFriendResponseAdapter({
        entry: { credential: authorization },
        fetcher,
        save: () => {},
      });
      const queue = createActionQueue({
        adapters: { "friend.response": responseAdapter },
        persist: (value) => {
          saved = value;
        },
        runInContext: (job, reconcile, run, _reservation, canDispatch) =>
          bridge.queueActionGate.run(
            job,
            reconcile,
            authorization,
            run,
            canDispatch,
          ),
      });
      queue.add({
        id: "test-job-1",
        type: "friend.response",
        args: { playerId: 42, decision: "accept" },
      });
      await queue.tick();
      assert.equal(sends, 1);
      assert.equal(saved[0].status, "completed");
      const body = JSON.stringify({
        workId: 7,
        taskId: 2,
        locale: "ru",
        operationId: "test-work",
      });
      const workRequest = {
        method: "POST",
        body,
        headers: { Authorization: authorization },
      };
      const workUrl = "https://cargohustle.online/api/works/tasks/perform";
      const permit = createWorkActionPermit({
        authorization,
        workId: 7,
        taskId: 2,
        operationId: "test-work",
        checkpointIsCurrent: () => true,
      });
      await bridge.queueActionGate.runWork(permit, async () => {
        await assert.rejects(transport.liveFetch(workUrl, workRequest));
        await assert.rejects(transport.liveFetch(workUrl, workRequest));
      });
      assert.equal(sends, 2);
      const sessionAuthorization = `Bearer ${session}`;
      const sessionBody = JSON.stringify({
        workId: 7,
        taskId: 2,
        locale: "ru",
        operationId: "session-work",
      });
      const sessionPermit = createWorkActionPermit({
        authorization: sessionAuthorization,
        workId: 7,
        taskId: 2,
        operationId: "session-work",
        checkpointIsCurrent: () => true,
      });
      await bridge.queueActionGate.runWork(sessionPermit, async () => {
        await assert.rejects(
          transport.liveFetch(workUrl, {
            method: "POST",
            body: sessionBody,
            headers: { Authorization: sessionAuthorization },
          }),
        );
      });
      assert.equal(sends, 3);
      const requestsBeforeOffline = requests;
      agent.kill();
      await waitStatus("offline");
      const offline = await fetch(url, {
        headers: { Authorization: "Bearer synthetic-token" },
      });
      assert.ok(offline.status >= 500);
      const offlinePermit = createWorkActionPermit({
        authorization,
        workId: 7,
        taskId: 2,
        operationId: "test-work",
        checkpointIsCurrent: () => true,
      });
      await bridge.queueActionGate.runWork(offlinePermit, async () => {
        await assert.rejects(transport.liveFetch(workUrl, workRequest));
      });
      assert.equal(requests, requestsBeforeOffline);
      const revoked = await command("revoke", { deviceId: paired.deviceId });
      assert.equal(revoked.status, 200);
      await assert.rejects(transport.verifyLocal(`Bearer ${session}`));
      const afterRevoke = await fetch(url, {
        headers: { Authorization: `Bearer ${session}` },
      });
      assert.ok(afterRevoke.status >= 400);
      assert.equal(requests, requestsBeforeOffline);
    } finally {
      agent?.kill();
      automation.close();
      bridge.close();
      await Promise.all([
        close(proxy),
        close(management),
        close(gateway),
        close(game),
      ]);
      await rm(root, { recursive: true, force: true });
    }
  },
);
