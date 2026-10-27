import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAutomationHttp } from "../scripts/automation/http.mjs";
import { createAutomationService } from "../scripts/automation/service.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";
import { createAccountSnapshots } from "../scripts/account/snapshots.mjs";
import { createRestoreOperationGuard } from "../scripts/automation/runtime.mjs";

const tokenA = "Bearer tokenA.payload.sig";
const tokenARotated = "Bearer tokenA2.payload.sig";
const tokenB = "Bearer tokenB.payload.sig";

function battle(
  now,
  id = "battle-1",
  status = "active",
  bossHealth = 40,
  myDamage = 60,
) {
  return {
    battleId: id,
    bossId: 7,
    status,
    serverTimeUtc: new Date(now).toISOString(),
    cooldownUntilUtc: new Date(now).toISOString(),
    expiresAtUtc: new Date(now + 120_000).toISOString(),
    retryAfterMilliseconds: 0,
    playerHealth: 80,
    playerMaxHealth: 100,
    bossHealth,
    bossMaxHealth: 100,
    myDamage,
    participantCount: 1,
    participants: [{ playerId: 7, nickname: "Player" }],
    actions: [],
  };
}

function fakeGame({ now = 1_000_000, finalReward } = {}) {
  const calls = [];
  let currentBattle = null;
  let holdAttack = false;
  let finishHeldAttack;
  const fetcher = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const authorization =
      init.headers?.Authorization || init.headers?.authorization || "";
    calls.push({
      method: init.method || "GET",
      path: url.pathname,
      authorization,
    });
    if (url.pathname === "/api/me/bag")
      return Response.json({
        activityItems: [{ itemId: 55, quantity: 12 }],
        combatItems: [
          { type: "heal_10", quantity: 4 },
          { type: "heal_full", quantity: 2 },
        ],
      });
    if (url.pathname === "/api/me") {
      const playerId = authorization.includes("tokenB") ? 202 : 101;
      return Response.json({
        playerId,
        nickname: playerId === 202 ? "Bee" : "Alice",
      });
    }
    if (url.pathname === "/api/bosses/7" && (init.method || "GET") === "GET")
      return Response.json({
        id: 7,
        damageMax: 10,
        activeBattle: null,
        state: { canStartFight: true },
      });
    if (
      url.pathname === "/api/bosses/battles/battle-1" &&
      (init.method || "GET") === "GET"
    )
      return Response.json(
        currentBattle?.status === "won" && finalReward
          ? { ...currentBattle, reward: finalReward }
          : currentBattle || battle(now),
      );
    if (url.pathname === "/api/bosses/7/battles" && init.method === "POST") {
      currentBattle = battle(now);
      return Response.json({ battle: currentBattle });
    }
    if (
      url.pathname === "/api/bosses/battles/battle-1/attack" &&
      init.method === "POST"
    ) {
      if (holdAttack)
        return new Promise((resolve) => {
          finishHeldAttack = () =>
            resolve(
              Response.json({ battle: battle(now, "battle-1", "won", 0, 70) }),
            );
        });
      currentBattle = battle(now, "battle-1", "won", 0);
      currentBattle.myDamage = 70;
      return Response.json({ battle: currentBattle });
    }
    return Response.json({ error: "unexpected_fake_route" }, { status: 404 });
  };
  return {
    calls,
    fetcher,
    holdAttack() {
      holdAttack = true;
    },
    finishAttack() {
      finishHeldAttack?.();
    },
  };
}

async function withContext(run, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "automation-service-test-"));
  const store = createAutomationStateStore({ directory });
  const game = fakeGame(options);
  const timers = [];
  const now = options.now ?? 1_000_000;
  const service = createAutomationService({
    store,
    getBoss: (id) => ({ numericId: id, name: "Boss" }),
    fetcher: game.fetcher,
    now: () => now,
    random: () => 0,
    schedule: (callback, delay) => {
      const handle = { callback, delay, canceled: false };
      timers.push(handle);
      return handle;
    },
    cancel: (handle) => {
      if (handle) handle.canceled = true;
    },
  });
  try {
    await run({ directory, store, game, service, timers, now });
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const command = (id, commandName, expectedVersion, args = {}) => ({
  id,
  command: commandName,
  expectedVersion,
  args,
});

async function openBoss(service, authorization = tokenA) {
  const entry = await service.identify(authorization);
  await service.command(
    entry,
    command("openboss1", "open", service.snapshot(entry).version, {
      bossId: 7,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return entry;
}

test("opening the boss dialog refreshes medicine stock before any battle exists", async () => {
  await withContext(async ({ service, game }) => {
    const entry = await openBoss(service);
    const state = service.snapshot(entry).battle;
    assert.equal(state.battle, null);
    assert.deepEqual(state.businessInventory, {
      stock: { 55: 12 },
      complete: true,
    });
    assert.deepEqual(
      state.medicines.map(({ type, quantity }) => ({ type, quantity })),
      [
        { type: "heal_10", quantity: 4 },
        { type: "heal_full", quantity: 2 },
      ],
    );
    await service.command(
      entry,
      command("reopen-stock", "open", service.snapshot(entry).version, {
        bossId: 7,
      }),
    );
    assert.equal(
      game.calls.filter(({ path }) => path === "/api/me/bag").length,
      2,
    );
  });
});

test("automation service drain stops accepting new account work", async () => {
  await withContext(async ({ service, game }) => {
    const entry = await service.identify(tokenA);
    assert.ok(entry);
    const callsBeforeDrain = game.calls.length;
    const savedVersion = service.snapshot(entry).version;

    service.beginDrain();

    await assert.rejects(service.identify(tokenB), (error) => {
      assert.equal(error.status, 503);
      return true;
    });
    assert.equal(game.calls.length, callsBeforeDrain);
    assert.equal(service.snapshot(entry).version, savedVersion);
  });
});

test("verified upstream identities partition records across users and token rotations", async () => {
  await withContext(async ({ store, service, game }) => {
    const first = await service.identify(tokenA);
    assert.equal(service.snapshot(first).battle.visible, false);
    const rotated = await service.identify(tokenARotated);
    assert.equal(first.playerId, rotated.playerId);
    const other = await service.identify(tokenB);
    assert.notEqual(other.playerId, first.playerId);

    const records = store.list();
    assert.deepEqual(records.map(({ playerId }) => playerId).sort(), [
      "101",
      "202",
    ]);
    assert.equal(
      records.find(({ playerId }) => playerId === "101").value.credential,
      tokenARotated,
    );
    assert.equal(
      records.find(({ playerId }) => playerId === "202").value.credential,
      tokenB,
    );
    const publicSnapshot = JSON.stringify(service.snapshot(rotated));
    assert.equal(publicSnapshot.includes("tokenA"), false);
    assert.equal(publicSnapshot.includes("tokenB"), false);
    assert.equal(publicSnapshot.includes("Alice"), false);
    assert.equal(game.calls.filter(({ path }) => path === "/api/me").length, 3);
  });
});

test("cached identity state reads do not make additional game calls", async () => {
  await withContext(async ({ service, game }) => {
    const http = createAutomationHttp({ service, enabled: true });
    const request = () =>
      http(
        new Request("https://wiki.test/api/automation/state", {
          headers: { authorization: tokenA },
        }),
      );
    assert.equal((await request()).status, 200);
    const countAfterFirst = game.calls.length;
    assert.equal((await request()).status, 200);
    assert.equal(game.calls.length, countAfterFirst);
    assert.equal(game.calls.filter(({ path }) => path === "/api/me").length, 1);
  });
});

test("HTTP command admissions use server IDs, do no game work, and return a replay receipt", async () => {
  await withContext(async ({ service, game }) => {
    const http = createAutomationHttp({ service, enabled: true });
    const entry = await service.identify(tokenA);
    const initialVersion = service.snapshot(entry).version;
    const request = (path, body) =>
      http(
        new Request(`https://wiki.test${path}`, {
          method: "POST",
          headers: {
            authorization: tokenA,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      );
    const gameCallsBeforeAdmission = game.calls.length;
    const admissionResponse = await request("/api/automation/command-ticket", {
      command: "favorites.set",
      expectedVersion: initialVersion,
      args: { bossIds: [7] },
    });
    assert.equal(admissionResponse.status, 200);
    const admission = await admissionResponse.json();
    assert.match(admission.id, /^[0-9a-f-]{36}$/u);
    assert.equal(admission.intentVersion, initialVersion + 1);
    assert.equal(admission.expiresAt, 1_000_000 + 5 * 60 * 1000);
    assert.equal(game.calls.length, gameCallsBeforeAdmission);

    const commandBody = {
      id: admission.id,
      admissionTicket: admission.ticket,
      expectedVersion: admission.intentVersion,
      command: "favorites.set",
      args: { bossIds: [7] },
    };
    await assert.rejects(
      () =>
        service.command(entry, {
          ...commandBody,
          args: { bossIds: [8] },
        }),
      (error) =>
        error.status === 403 &&
        error.message === "automation_command_admission_mismatch",
    );
    const response = await request("/api/automation/commands", commandBody);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).preferences.favoriteBossIds, [7]);
    const gameCallsAfterCommand = game.calls.length;
    const duplicate = await request("/api/automation/commands", commandBody);
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).commandReceipt.id, admission.id);
    assert.equal(game.calls.length, gameCallsAfterCommand);

    const reissue = await request("/api/automation/command-ticket", {
      id: admission.id,
      command: "favorites.set",
      expectedVersion: service.snapshot(entry).version,
      args: { bossIds: [7] },
    });
    assert.equal(reissue.status, 400);
    assert.equal((await reissue.json()).error, "invalid_automation_command");
    assert.equal(game.calls.length, gameCallsAfterCommand);
  });
});

test("new stop controls remain available on a bridge route without a ticket", async () => {
  await withContext(async ({ store, service, game, now }) => {
    const entry = await service.identify(tokenA);
    store.selectRoutePolicy("101", {
      policy: "bridge_required",
      activeDeviceId: "00000000-0000-4000-8000-000000000001",
      expectedRouteEpoch: 0,
      updatedAt: now,
    });
    const gameCallsBefore = game.calls.length;
    for (const name of ["floor.stop", "character.stop", "subscription.stop"]) {
      const input = {
        command: name,
        expectedVersion: service.snapshot(entry).version,
        args: {},
      };
      assert.throws(() => service.issueCommandTicket(entry, input), {
        message: "invalid_automation_command_ticket_request",
      });
      await service.command(entry, input);
    }
    assert.equal(game.calls.length, gameCallsBefore);
  });
});

test("expired command admission stays rejected after its receipt leaves the ring", async () => {
  const directory = mkdtempSync(join(tmpdir(), "automation-admission-expiry-"));
  const store = createAutomationStateStore({ directory });
  let clock = 1_000_000;
  const service = createAutomationService({
    store,
    getBoss: (id) => ({ numericId: id, name: "Boss" }),
    identifyPlayer: async () => ({ playerId: 101, nickname: "Alice" }),
    now: () => clock,
    schedule: () => null,
    cancel: () => {},
  });
  try {
    const entry = await service.identify(tokenA);
    const admission = service.issueCommandTicket(entry, {
      command: "favorites.set",
      expectedVersion: service.snapshot(entry).version,
      args: { bossIds: [7] },
    });
    const original = {
      id: admission.id,
      admissionTicket: admission.ticket,
      expectedVersion: admission.intentVersion,
      command: "favorites.set",
      args: { bossIds: [7] },
    };
    await service.command(entry, original);
    clock += 5 * 60 * 1000 + 1;

    for (let index = 0; index < 128; index += 1) {
      const args = { bossIds: [index + 1] };
      const next = service.issueCommandTicket(entry, {
        command: "favorites.set",
        expectedVersion: service.snapshot(entry).version,
        args,
      });
      await service.command(entry, {
        id: next.id,
        admissionTicket: next.ticket,
        expectedVersion: next.intentVersion,
        command: "favorites.set",
        args,
      });
    }
    assert.equal(store.read("101").receipts.includes(admission.id), false);
    await assert.rejects(
      () => service.command(entry, original),
      (error) =>
        error.status === 409 &&
        error.message === "automation_command_admission_expired",
    );
    assert.throws(
      () =>
        service.issueCommandTicket(entry, {
          id: admission.id,
          command: "favorites.set",
          expectedVersion: service.snapshot(entry).version,
          args: { bossIds: [7] },
        }),
      (error) => error.message === "automation_command_id_server_generated",
    );
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("goal counters survive service restart and duplicate command receipts do not replay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "automation-goal-restart-"));
  const store1 = createAutomationStateStore({ directory });
  const game = fakeGame();
  const makeService = (store) =>
    createAutomationService({
      store,
      getBoss: (id) => ({ numericId: id, name: "Boss" }),
      fetcher: game.fetcher,
      now: () => 1_000_000,
      random: () => 0,
    });
  let service = makeService(store1);
  let activeStore = store1;
  try {
    let entry = await openBoss(service);
    let snap = service.snapshot(entry);
    await service.command(
      entry,
      command("goalcfg01", "goal.configure", snap.version, {
        bossId: 7,
        kind: "battles",
        targetCount: 2,
        maxAttempts: 3,
      }),
    );
    snap = service.snapshot(entry);
    await service.command(entry, command("start001", "start", snap.version));
    snap = service.snapshot(entry);
    await service.command(entry, command("attack01", "attack", snap.version));
    snap = service.snapshot(entry);
    assert.deepEqual(
      [snap.goal.attempts, snap.goal.wins, snap.goal.losses],
      [1, 1, 0],
    );

    await new Promise((resolve) => setImmediate(resolve));
    snap = service.snapshot(entry);
    const receipt = command("favorite1", "favorites.set", snap.version, {
      bossIds: [7],
    });
    await service.command(entry, receipt);
    await assert.rejects(
      service.command(entry, receipt),
      (error) => error.status === 409,
    );
    const before = game.calls.filter(
      ({ method, path }) => method === "POST" && path.includes("/attack"),
    ).length;

    service.close();
    service = null;
    store1.close();
    const store2 = createAutomationStateStore({ directory });
    activeStore = store2;
    service = makeService(store2);
    entry = await service.identify(tokenARotated);
    snap = service.snapshot(entry);
    assert.deepEqual(
      [snap.goal.attempts, snap.goal.wins, snap.goal.losses],
      [1, 1, 0],
    );
    await assert.rejects(
      service.command(entry, receipt),
      (error) => error.status === 409,
    );
    assert.equal(
      game.calls.filter(
        ({ method, path }) => method === "POST" && path.includes("/attack"),
      ).length,
      before,
    );
  } finally {
    service?.close();
    try {
      activeStore.close();
    } catch {
      /* already closed */
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stale expectedVersion is rejected without repeating a mutation", async () => {
  await withContext(async ({ service }) => {
    const entry = await service.identify(tokenA);
    const version = service.snapshot(entry).version;
    await service.command(
      entry,
      command("favorite2", "favorites.set", version, { bossIds: [7] }),
    );
    await assert.rejects(
      service.command(
        entry,
        command("favorite3", "favorites.set", version, { bossIds: [8] }),
      ),
      (error) => error.status === 409,
    );
    assert.deepEqual(service.snapshot(entry).preferences.favoriteBossIds, [7]);
  });
});

test("disabled API, origin, method, content type, and body limits reject before game calls", async () => {
  await withContext(async ({ service, game }) => {
    const disabled = createAutomationHttp({ service, enabled: false });
    assert.equal(
      (
        await disabled(
          new Request("https://wiki.test/api/automation/state", {
            headers: { authorization: tokenA },
          }),
        )
      ).status,
      503,
    );
    assert.equal(game.calls.length, 0);

    const http = createAutomationHttp({
      service,
      enabled: true,
      origin: "https://wiki.test",
    });
    const cases = [
      new Request("https://wiki.test/api/automation/state", { method: "POST" }),
      new Request("https://wiki.test/api/automation/state", {
        headers: { authorization: tokenA, origin: "https://evil.test" },
      }),
      new Request("https://wiki.test/api/automation/commands", {
        method: "POST",
        headers: { authorization: tokenA, "content-type": "text/plain" },
        body: "{}",
      }),
      new Request("https://wiki.test/api/automation/commands", {
        method: "POST",
        headers: { authorization: tokenA, "content-type": "application/json" },
        body: JSON.stringify({ data: "x".repeat(17_000) }),
      }),
    ];
    const statuses = [];
    for (const request of cases) statuses.push((await http(request)).status);
    assert.deepEqual(statuses, [405, 403, 415, 413]);
    assert.equal(game.calls.length, 0);
  });
});

test("boot resumes one auto strike without a browser connection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "automation-auto-boot-"));
  const store = createAutomationStateStore({ directory });
  const game = fakeGame();
  let now = 1_000_000;
  const savedBattle = {
    visible: false,
    boss: { id: 7, name: "Boss", reference: {} },
    battle: {
      id: "battle-1",
      status: "active",
      playerHealth: 80,
      playerMaxHealth: 100,
      bossHealth: 40,
      bossMaxHealth: 100,
      readyAt: now + 1_000,
      cooldownKnown: true,
      expiresAt: now + 120_000,
      needsRefresh: false,
      rewards: [],
      currencyRewards: [],
      grantedDrops: [],
      events: [],
      participants: [],
      detailsLoaded: true,
    },
    pending: null,
    needsRefresh: false,
    error: null,
    errorStatus: null,
    canStart: false,
    medicineOpen: false,
    medicines: null,
    purchase: null,
    purchaseUncertain: false,
    notice: null,
  };
  store.write(101, {
    version: 4,
    credential: tokenA,
    player: { playerId: 101, nickname: "Alice" },
    battle: savedBattle,
    goalRecord: null,
    auto: { enabled: true, nextAttackAt: now, pause: false },
    pvp: { battle: null, pending: false, error: false },
    preferences: { favoriteBossIds: [] },
    receipts: [],
    updatedAt: now,
  });
  const timers = [];
  const service = createAutomationService({
    store,
    getBoss: (id) => ({ numericId: id, name: "Boss" }),
    fetcher: game.fetcher,
    now: () => now,
    random: () => 0,
    schedule: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    cancel: () => {},
  });
  try {
    await service.boot();
    assert.equal(
      game.calls.some(
        ({ method, path }) => method === "POST" && path.endsWith("/attack"),
      ),
      false,
    );
    assert.ok(timers.length > 0);
    now += 2_000;
    timers[0].callback();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(
      game.calls.filter(
        ({ method, path }) => method === "POST" && path.endsWith("/attack"),
      ).length,
      1,
    );
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restart with a durable pending mutation does not replay the game POST", async () => {
  const directory = mkdtempSync(join(tmpdir(), "automation-pending-restart-"));
  const store1 = createAutomationStateStore({ directory });
  const game = fakeGame();
  game.holdAttack();
  const makeService = (store) =>
    createAutomationService({
      store,
      getBoss: (id) => ({ numericId: id, name: "Boss" }),
      fetcher: game.fetcher,
      now: () => 1_000_000,
      random: () => 0,
    });
  let service = makeService(store1);
  let activeStore = store1;
  try {
    const entry = await openBoss(service);
    let snap = service.snapshot(entry);
    await service.command(entry, command("start002", "start", snap.version));
    snap = service.snapshot(entry);
    const pendingCommand = service.command(
      entry,
      command("attack02", "attack", snap.version),
    );
    for (
      let i = 0;
      i < 5 &&
      !game.calls.some(
        ({ method, path }) => method === "POST" && path.endsWith("/attack"),
      );
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(
      game.calls.filter(
        ({ method, path }) => method === "POST" && path.endsWith("/attack"),
      ).length,
      1,
    );
    const saved = store1.read("101");
    assert.equal(saved.battle.pending, "attack");
    assert.equal(saved.battle.needsRefresh, true);

    service.close();
    service = null;
    store1.close();
    const store2 = createAutomationStateStore({ directory });
    activeStore = store2;
    service = makeService(store2);
    const restored = await service.identify(tokenARotated);
    assert.equal(service.snapshot(restored).battle.needsRefresh, true);
    assert.equal(
      game.calls.filter(
        ({ method, path }) => method === "POST" && path.endsWith("/attack"),
      ).length,
      1,
    );
    game.finishAttack();
    await pendingCommand;
  } finally {
    service?.close();
    try {
      activeStore.close();
    } catch {
      /* already closed */
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restore guard prevents boot from resuming a previously enabled automation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "automation-restore-boot-"));
  const store = createAutomationStateStore({ directory });
  const calls = [];
  store.write("101", {
    credential: tokenA,
    player: { playerId: 101, nickname: "Alice" },
    battle: { pending: null, needsRefresh: false },
    auto: { enabled: true, phase: "between_battles", nextAttackAt: 1000 },
    goalRecord: null,
    receipts: [],
  });
  store.activateRestoreGuard({ activatedAt: 2000 });
  const service = createAutomationService({
    store,
    getBoss: (id) => ({ numericId: id, name: "Boss" }),
    fetcher: async (...args) => {
      calls.push(args);
      return Response.json({ ok: true });
    },
  });
  try {
    await service.boot();
    assert.equal(calls.length, 0);
    assert.equal(store.read("101").auto.enabled, true);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("route change durably stops running automation before the route can switch", async () => {
  await withContext(async ({ store, service, game, now }) => {
    const ownerId = "7654321";
    const playerId = "101";
    store.bindVerifiedGameAccount(ownerId, playerId, now);
    store.selectRoutePolicy(playerId, {
      policy: "bridge_required",
      activeDeviceId: "00000000-0000-4000-8000-000000000001",
      expectedRouteEpoch: 0,
      updatedAt: now,
    });
    store.write(playerId, {
      credential: tokenA,
      player: { playerId: Number(playerId), nickname: "Alice" },
      battle: { pending: null, needsRefresh: false },
      auto: { enabled: true, phase: "between_battles", nextAttackAt: now },
      goalRecord: null,
      receipts: [],
    });
    const previous = store.readRoutePolicy(playerId);

    assert.equal(
      await service.pauseForRouteChange({ ownerId, previous }),
      true,
    );
    assert.equal(store.read(playerId).auto.enabled, false);
    assert.equal(store.read(playerId).raid.enabled, false);
    assert.deepEqual(game.calls, []);
  });
});

test("restore credential adoption stops old work while retaining unresolved effects", async () => {
  await withContext(async ({ store, service, game }) => {
    const ownerId = "7654321";
    const playerId = "101";
    const requestId = "00000000-0000-4000-8000-000000000140";
    const operationId = "00000000-0000-4000-8000-000000000141";
    const timestamp = 1000;
    store.write(playerId, {
      credential: tokenA,
      player: { playerId: 101, nickname: "Old" },
      auto: {
        enabled: true,
        phase: "between_battles",
        nextAttackAt: timestamp,
      },
      characterUpgrade: {
        pending: { stat: "strength", before: 1 },
        run: { status: "running" },
      },
    });
    store.activateRestoreGuard({ activatedAt: timestamp });
    const challenge = store.issueRestoreOwnerChallenge({
      ownerId,
      issuedAt: timestamp,
      identityIssuedAt: timestamp,
    });
    store.recordRestoreOwnerConsent({
      ownerId,
      requestId,
      routePolicy: "direct",
      confirmedAt: timestamp,
      identityIssuedAt: timestamp,
      challenge: challenge.challenge,
    });
    let journal = store.startRestoreGameAuthBootstrap({
      schemaVersion: 1,
      ownerId,
      requestId,
      operationId,
      authGeneration: 1,
      consentGeneration: 1,
      routeEpoch: 1,
      launchDataDigest: "a".repeat(64),
      state: "prepared",
      expectedCredentialVersion: 0,
      credentialVersion: null,
      playerId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    for (const state of ["exchange_pending", "verification_pending"])
      journal = store.updateGameAuthBootstrap(ownerId, operationId, {
        ...journal,
        state,
        updatedAt: journal.updatedAt + 1,
      });
    store.updateGameAuthBootstrap(ownerId, operationId, {
      ...journal,
      state: "credential_stored",
      playerId,
      credentialVersion: 1,
      updatedAt: journal.updatedAt + 1,
    });
    store.stageRestoredGameAccount({
      ownerId,
      playerId,
      operationId,
      verifiedAt: timestamp + 10,
    });
    const input = {
      ownerId,
      playerId,
      authOperationId: operationId,
      bootstrapOperationId: operationId,
      authGeneration: 1,
      consentGeneration: 1,
      routeEpoch: 1,
      credentialVersion: 1,
      accessToken: "fresh.payload.sig",
      profile: { telegramId: Number(ownerId), playerId: 101 },
      restored: true,
    };
    await service.adoptGameCredential(input);
    const saved = store.read(playerId);
    assert.equal(saved.credential, "Bearer fresh.payload.sig");
    assert.equal(saved.auto.enabled, false);
    assert.ok(saved.characterUpgrade.pending);
    assert.equal(store.isRestoreAccountReauthorized(playerId), false);
    assert.equal(store.isRestoreRequired(playerId), true);
    assert.deepEqual(game.calls, []);
    await assert.rejects(
      service.adoptGameCredential({
        ...input,
        authOperationId: "00000000-0000-4000-8000-000000000142",
      }),
      { status: 409 },
    );
  });
});

test("fresh owner confirmation stops old automation before reopening the account gate", async () => {
  const directory = mkdtempSync(join(tmpdir(), "automation-restore-confirm-"));
  const store = createAutomationStateStore({ directory });
  store.write("101", {
    credential: tokenA,
    player: { playerId: 101, nickname: "Old Alice" },
    battle: { pending: null, needsRefresh: false },
    auto: { enabled: true, phase: "between_battles", nextAttackAt: 1000 },
    pvp: {
      battle: { id: "closed", status: "won" },
      pending: false,
      error: false,
    },
    goalRecord: null,
    receipts: [],
  });
  store.bindVerifiedGameAccount("7654321", "101", 3000);
  const service = createAutomationService({
    store,
    getBoss: (id) => ({ numericId: id, name: "Boss" }),
    identifyPlayer: async () => ({ playerId: 101, nickname: "Alice" }),
  });
  try {
    const entry = await service.identify(tokenA);
    const restoredTicket = service.issueCommandTicket(entry, {
      command: "favorites.set",
      expectedVersion: service.snapshot(entry).version,
      args: { bossIds: [7] },
    });
    entry.characterUpgrade.run = { status: "running" };
    entry.floorRunner.start();
    store.activateRestoreGuard({ activatedAt: 2000 });
    store.bindVerifiedGameAccount("7654321", "101", 3001);
    await assert.rejects(
      () =>
        service.command(
          entry,
          command("restore01", "auto.start", service.snapshot(entry).version),
        ),
      /automation_restore_confirmation_required/u,
    );
    assert.equal(store.isRestoreRequired("101"), true);

    await service.confirmRestoredAccount({
      ownerId: "7654321",
      playerId: "101",
      authorization: tokenA,
    });
    assert.equal(store.isRestoreRequired("101"), true);
    store.selectRoutePolicy("101", {
      policy: "direct",
      activeDeviceId: null,
      expectedRouteEpoch: 0,
      updatedAt: 3002,
    });
    assert.equal(store.isRestoreRequired("101"), false);
    assert.equal(store.read("101").auto.enabled, false);
    assert.equal(store.read("101").characterUpgrade.run.status, "stopped");
    assert.equal(store.read("101").floorRunner.status, "stopped");
    assert.equal(store.read("101").commandAdmissions.length, 0);
    await assert.rejects(
      () =>
        service.command(entry, {
          id: restoredTicket.id,
          admissionTicket: restoredTicket.ticket,
          expectedVersion: restoredTicket.intentVersion,
          command: "favorites.set",
          args: { bossIds: [7] },
        }),
      /automation_command_admission_mismatch/u,
    );
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restored Buddy acknowledgement uses reads and rejects a newer restore", async () => {
  for (const interrupted of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), "automation-restore-buddy-"));
    const store = createAutomationStateStore({ directory });
    const calls = [];
    let resetOnRead = false;
    const fetcher = async (url, init = {}) => {
      const path = new URL(url).pathname;
      calls.push({ path, method: init.method || "GET" });
      if (resetOnRead) store.prepareRestoredSnapshot({ activatedAt: 2000 });
      if (path === "/api/player-interactions/booster-requests/incoming")
        return Response.json({ items: [], nextCursor: null });
      if (path === "/api/stash/help-requests/42")
        return Response.json({ items: [], remainingToday: 1 });
      throw new Error("unexpected synthetic game route");
    };
    store.write("101", {
      credential: tokenA,
      player: { playerId: 101, nickname: "Synthetic" },
      buddyHelp: {
        pending: {
          playerId: 42,
          requestId: "req-1",
          operationId: "op-1",
          expiresAt: 20000,
        },
        stashPending: {
          playerId: 42,
          setId: 1,
          ingredientId: 2,
          operationId: "op-2",
        },
      },
    });
    const snapshots = createAccountSnapshots({
      store,
      fetcher,
      allowOperation: createRestoreOperationGuard(store),
    });
    snapshots.registerVerifiedCredential(tokenA, "101");
    const service = createAutomationService({
      store,
      getBoss: (id) => ({ numericId: id }),
      fetcher: snapshots.liveFetch,
      identifyPlayer: async () => ({ playerId: 101, nickname: "Synthetic" }),
      now: () => 10000,
    });
    try {
      const entry = await service.identify(tokenA);
      calls.length = 0;
      store.activateRestoreGuard({ activatedAt: 1000 });
      await assert.rejects(
        service.command(entry, {
          ...command(
            "buddy-before",
            "buddy.resolve",
            service.snapshot(entry).version,
          ),
          args: { kind: "booster" },
        }),
        /automation_restore_confirmation_required/u,
      );
      assert.equal(calls.length, 0);
      store.bindVerifiedGameAccount("7654321", "101", 1001);
      store.confirmRestoredAccount({
        ownerId: "7654321",
        playerId: "101",
        verifiedAt: 1002,
      });
      store.selectRoutePolicy("101", {
        policy: "direct",
        activeDeviceId: null,
        expectedRouteEpoch: 0,
        updatedAt: 1003,
      });
      resetOnRead = interrupted;
      const resolve = (id, kind) =>
        service.command(entry, {
          ...command(id, "buddy.resolve", service.snapshot(entry).version),
          args: { kind },
        });
      if (interrupted) {
        await assert.rejects(resolve("buddy-race", "booster"));
        assert.ok(store.read("101").buddyHelp.pending);
        assert.ok(store.read("101").buddyHelp.stashPending);
      } else {
        await resolve("buddy-booster", "booster");
        assert.equal(store.read("101").buddyHelp.pending, null);
        assert.equal(
          store.read("101").buddyHelp.completed[0].requestId,
          "req-1",
        );
        await resolve("buddy-stash", "stash");
        assert.equal(store.read("101").buddyHelp.stashPending, null);
        assert.deepEqual(store.read("101").buddyHelp.stashBlocked, [
          { playerId: 42, setId: 1, ingredientId: 2 },
        ]);
      }
      assert.ok(calls.length > 0);
      assert.ok(calls.every(({ method }) => method === "GET"));
    } finally {
      service.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("restored friend removal reconciles only by reads after owner confirmation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "automation-restore-friend-"));
  const store = createAutomationStateStore({ directory });
  const calls = [];
  let friendPresent = true;
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method || "GET" });
    if (path === "/api/friends")
      return Response.json({
        items: friendPresent ? [{ player: { playerId: 7 } }] : [],
        nextCursor: null,
      });
    if (path === "/api/friends/requests/outgoing")
      return Response.json({ items: [], nextCursor: null });
    throw new Error("unexpected synthetic game route");
  };
  store.write("101", {
    credential: tokenA,
    player: { playerId: 101, nickname: "Synthetic" },
    friendRemoval: { pending: { playerId: 7, commandId: "old-command" } },
  });
  const snapshots = createAccountSnapshots({
    store,
    fetcher,
    allowOperation: createRestoreOperationGuard(store),
  });
  snapshots.registerVerifiedCredential(tokenA, "101");
  const service = createAutomationService({
    store,
    getBoss: (id) => ({ numericId: id }),
    fetcher: snapshots.liveFetch,
    identifyPlayer: async () => ({ playerId: 101, nickname: "Synthetic" }),
    now: () => 10000,
  });
  try {
    const entry = await service.identify(tokenA);
    calls.length = 0;
    store.activateRestoreGuard({ activatedAt: 1000 });
    await assert.rejects(
      () =>
        service.command(
          entry,
          command(
            "friendcheck01",
            "friends.reconcile",
            service.snapshot(entry).version,
          ),
        ),
      /automation_restore_confirmation_required/u,
    );
    assert.equal(calls.length, 0);
    store.bindVerifiedGameAccount("7654321", "101", 1001);
    store.confirmRestoredAccount({
      ownerId: "7654321",
      playerId: "101",
      verifiedAt: 1002,
    });
    store.selectRoutePolicy("101", {
      policy: "direct",
      activeDeviceId: null,
      expectedRouteEpoch: 0,
      updatedAt: 1003,
    });
    await service.command(
      entry,
      command(
        "friendcheck02",
        "friends.reconcile",
        service.snapshot(entry).version,
      ),
    );
    assert.ok(store.read("101").friendRemoval.pending);
    assert.equal(store.isRestoreRequired("101"), true);
    friendPresent = false;
    await service.command(
      entry,
      command(
        "friendcheck03",
        "friends.reconcile",
        service.snapshot(entry).version,
      ),
    );
    assert.equal(store.read("101").friendRemoval.pending, null);
    assert.equal(store.isRestoreRequired("101"), false);
    assert.ok(calls.length >= 2);
    assert.ok(calls.every(({ method }) => method === "GET"));
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restored friend request remains uncertain until a friend or outgoing request is observed", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "automation-restore-friend-request-"),
  );
  const store = createAutomationStateStore({ directory });
  const calls = [];
  let outgoing = false;
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method || "GET" });
    if (path === "/api/friends")
      return Response.json({ items: [], nextCursor: null });
    if (path === "/api/friends/requests/outgoing")
      return Response.json({
        items: outgoing ? [{ player: { playerId: 7 } }] : [],
        nextCursor: null,
      });
    throw new Error("unexpected synthetic game route");
  };
  store.write("101", {
    credential: tokenA,
    player: { playerId: 101, nickname: "Synthetic" },
    raidFriend: {
      pending: { playerId: 7, commandId: "old-command" },
      playerId: 7,
      status: "uncertain",
    },
  });
  const snapshots = createAccountSnapshots({
    store,
    fetcher,
    allowOperation: createRestoreOperationGuard(store),
  });
  snapshots.registerVerifiedCredential(tokenA, "101");
  const service = createAutomationService({
    store,
    getBoss: (id) => ({ numericId: id }),
    fetcher: snapshots.liveFetch,
    identifyPlayer: async () => ({ playerId: 101, nickname: "Synthetic" }),
    now: () => 10000,
  });
  try {
    const entry = await service.identify(tokenA);
    calls.length = 0;
    store.activateRestoreGuard({ activatedAt: 1000 });
    await assert.rejects(
      () =>
        service.command(
          entry,
          command(
            "raidfriend01",
            "raid.friend.refresh",
            service.snapshot(entry).version,
          ),
        ),
      /automation_restore_confirmation_required/u,
    );
    assert.equal(calls.length, 0);
    store.bindVerifiedGameAccount("7654321", "101", 1001);
    store.confirmRestoredAccount({
      ownerId: "7654321",
      playerId: "101",
      verifiedAt: 1002,
    });
    store.selectRoutePolicy("101", {
      policy: "direct",
      activeDeviceId: null,
      expectedRouteEpoch: 0,
      updatedAt: 1003,
    });
    await service.command(
      entry,
      command(
        "raidfriend02",
        "raid.friend.refresh",
        service.snapshot(entry).version,
      ),
    );
    assert.ok(store.read("101").raidFriend.pending);
    assert.equal(store.isRestoreRequired("101"), true);
    outgoing = true;
    await service.command(
      entry,
      command(
        "raidfriend03",
        "raid.friend.refresh",
        service.snapshot(entry).version,
      ),
    );
    assert.equal(store.read("101").raidFriend.pending, null);
    assert.equal(store.read("101").raidFriend.status, "pending");
    assert.equal(store.isRestoreRequired("101"), false);
    assert.ok(calls.every(({ method }) => method === "GET"));
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restore guard prevents background reads and actions for an already loaded account", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "automation-restore-background-"),
  );
  const store = createAutomationStateStore({ directory });
  store.write("101", {
    credential: tokenA,
    raidFriend: { status: "uncertain", pending: { playerId: 9 } },
  });
  store.activateRestoreGuard({ activatedAt: 1000 });
  const calls = [];
  const service = createAutomationService({
    store,
    identifyPlayer: async () => ({ playerId: 101, nickname: "Alice" }),
    getBoss: () => null,
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return Response.json({});
    },
  });
  try {
    await service.boot();
    await service.identify(tokenA);
    calls.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 1150));
    assert.equal(calls.length, 0);
    assert.equal(store.isRestoreRequired("101"), true);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("discovery adopts only an explicit account battle reference and local reads never scan bosses", async () => {
  const directory = mkdtempSync(join(tmpdir(), "automation-discovery-"));
  const store = createAutomationStateStore({ directory });
  const paths = [];
  const active = battle(1_000_000);
  const service = createAutomationService({
    store,
    now: () => 1_000_000,
    getBoss: (id) => ({ numericId: id, name: "Boss" }),
    fetcher: async (url) => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path === "/api/me")
        return Response.json({
          playerId: 101,
          activeBossBattle: {
            battleId: "battle-1",
            bossId: 7,
            remainingSeconds: 120,
          },
        });
      if (path === "/api/bosses/battles/battle-1") return Response.json(active);
      if (path === "/api/combat") return Response.json({ activeBattle: null });
      throw new Error("Unexpected game route");
    },
  });
  try {
    const entry = await service.identify(tokenA);
    assert.equal(service.snapshot(entry).battle.battle.id, "battle-1");
    assert.equal(service.snapshot(entry).battle.battle.bossHealth, 40);
    const count = paths.length;
    await service.identify(tokenA);
    service.snapshot(entry);
    assert.equal(paths.length, count);
    assert.deepEqual(paths, [
      "/api/me",
      "/api/bosses/battles/battle-1",
      "/api/combat",
    ]);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("quantitative goal enforces its server deadline before every POST and survives restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "automation-goal-deadline-"));
  let clock = 1_000_000;
  const started = clock;
  const store = createAutomationStateStore({ directory });
  let posts = 0;
  let ownDamage = 60;
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === "/api/me") return Response.json({ playerId: 101 });
    if (path === "/api/combat") return Response.json({ activeBattle: null });
    if (path === "/api/bosses/7")
      return Response.json({
        id: 7,
        damageMax: 10,
        state: { canStartFight: true },
        activeBattle: null,
      });
    const raw = {
      ...battle(clock, "battle-1", "active", 40, ownDamage),
      expiresAtUtc: new Date(started + 24 * 3600000).toISOString(),
    };
    if (init.method === "POST") {
      posts++;
      ownDamage++;
      return Response.json({ battle: { ...raw, myDamage: ownDamage } });
    }
    return Response.json(raw);
  };
  const create = () =>
    createAutomationService({
      store,
      fetcher,
      now: () => clock,
      getBoss: (id) => ({ numericId: id, name: "Boss" }),
    });
  let service = create();
  try {
    let entry = await openBoss(service);
    await service.command(
      entry,
      command("goal-start", "start", service.snapshot(entry).version),
    );
    await service.command(
      entry,
      command(
        "goal-deadline",
        "goal.configure",
        service.snapshot(entry).version,
        {
          bossId: 7,
          kind: "battles",
          targetCount: 3,
          durationHours: 1,
        },
      ),
    );
    assert.equal(service.snapshot(entry).goal.deadlineAt, started + 3600000);
    clock = started + 3599000;
    await service.command(
      entry,
      command("goal-hit1", "attack", service.snapshot(entry).version),
    );
    assert.equal(posts, 2);
    clock = started + 3600000;
    await service.command(
      entry,
      command("goal-hit2", "attack", service.snapshot(entry).version),
    );
    assert.equal(posts, 2);
    assert.equal(service.snapshot(entry).goal.status, "expired");
    service.close();
    service = create();
    entry = await service.identify(tokenA);
    assert.equal(service.snapshot(entry).goal.deadlineAt, started + 3600000);
    assert.equal(service.snapshot(entry).goal.status, "expired");
    assert.equal(posts, 2);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("explicit stop clears goal progress and deadline while retaining next-run settings", async () => {
  await withContext(async ({ service, game, now }) => {
    const entry = await openBoss(service);
    const settings = {
      bossId: 7,
      kind: "battles",
      targetCount: 5,
      countWins: true,
      durationHours: 1,
      maxAttempts: null,
    };
    const send = (id, name, args) =>
      service.command(
        entry,
        command(id, name, service.snapshot(entry).version, args),
      );
    await send("enable-settings-01", "auto.start", { settings });
    assert.equal(service.snapshot(entry).auto.enabled, true);
    assert.equal(service.snapshot(entry).goal.targetCount, 5);
    assert.equal(service.snapshot(entry).goal.countWins, true);
    assert.equal(service.snapshot(entry).goal.maxAttempts, null);
    assert.equal(service.snapshot(entry).goal.deadlineAt, now + 3600000);
    assert.equal(game.calls.filter((call) => call.method === "POST").length, 0);
    await send("disable-settings-01", "auto.stop");
    assert.equal(service.snapshot(entry).goal.status, "stopped");
    assert.equal(service.snapshot(entry).goal.remainingSeconds, null);
    assert.equal(service.snapshot(entry).goal.progress, 0);
    assert.equal(service.snapshot(entry).goal.durationHours, 1);
    await send("manual-start-001", "start");
    await send("manual-attack-01", "attack");
    assert.equal(service.snapshot(entry).goal.wins, 0);
    await send("enable-settings-02", "auto.start", { settings });
    assert.equal(service.snapshot(entry).goal.wins, 0);
    assert.equal(service.snapshot(entry).auto.enabled, true);
    await send("disable-settings-02", "auto.stop");
  });
});

test("terminal victory without reward is reconciled by GET and records the returned drop", async () => {
  await withContext(
    async ({ service, game }) => {
      const entry = await openBoss(service);
      await service.command(
        entry,
        command("reward-start", "start", service.snapshot(entry).version),
      );
      await service.command(
        entry,
        command("reward-attack", "attack", service.snapshot(entry).version),
      );
      service.snapshot(entry);
      await new Promise((resolve) => setImmediate(resolve));
      const result = service.snapshot(entry).battle.battle;
      assert.equal(result.rewardKnown, true);
      assert.equal(result.grantedDrops[0].amount, 1);
      assert.equal(result.grantedDrops[0].mutagenType, "W");
      assert.equal(game.calls.filter((c) => c.method === "POST").length, 2);
    },
    {
      finalReward: {
        guaranteed: {},
        drops: [
          {
            type: "mutagen",
            mutagenType: "W",
            mutagenLevel: 14,
            amount: 1,
            granted: true,
          },
        ],
      },
    },
  );
});

test("app launch restores auth battle hints over a previous boss without scanning or mutations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "automation-launch-"));
  const store = createAutomationStateStore({ directory });
  const paths = [];
  let active = battle(1_000_000, "manual-battle");
  const service = createAutomationService({
    store,
    now: () => 1_000_000,
    getBoss: (id) => ({ numericId: id, name: `Boss ${id}` }),
    fetcher: async (url, init = {}) => {
      assert.equal(init.method ?? "GET", "GET");
      const path = new URL(url).pathname;
      paths.push(path);
      if (path === "/api/me") return Response.json({ playerId: 101 });
      if (path === "/api/combat") return Response.json({ activeBattle: null });
      if (path === "/api/bosses/8")
        return Response.json({
          id: 8,
          activeBattle: null,
          state: { canStartFight: true },
        });
      if (path === "/api/bosses/7")
        return Response.json({
          id: 7,
          damageMax: 10,
          activeBattle: active,
          state: { canStartFight: false },
        });
      if (path === "/api/bosses/battles/manual-battle")
        return Response.json(active);
      throw new Error(`Unexpected game route ${path}`);
    },
  });
  try {
    const entry = await service.identify(tokenA);
    await service.command(
      entry,
      command("open-old-boss", "open", service.snapshot(entry).version, {
        bossId: 8,
      }),
    );
    const http = createAutomationHttp({ service });
    const launch = (activeBossBattle) =>
      http(
        new Request("https://wiki.test/api/automation/launch", {
          method: "POST",
          headers: {
            authorization: tokenA,
            "content-type": "application/json",
          },
          body: JSON.stringify({ activeBossBattle }),
        }),
      );
    const start = paths.length;
    // A forged/stale battle ID is not used for the detail read. The game's
    // authenticated summary decides which fight belongs to this account.
    const response = await launch({ bossId: 7, battleId: "untrusted-id" });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.battle.boss.id, 7);
    assert.equal(value.battle.battle.id, "manual-battle");
    assert.equal(value.battle.battle.detailsLoaded, true);
    assert.equal(value.auto.enabled, false);
    assert.equal(value.raid.enabled, false);
    assert.ok(
      paths
        .slice(start)
        .every((path) =>
          ["/api/bosses/7", "/api/bosses/battles/manual-battle"].includes(path),
        ),
    );
    assert.equal(paths.includes("/api/bosses/battles/untrusted-id"), false);
    active = null;
    const ended = await launch({ bossId: 7, battleId: "manual-battle" });
    assert.equal(ended.status, 200);
    assert.equal((await ended.json()).battle.battle, null);
    assert.equal(
      (await launch({ bossId: 7, battleId: "../invalid" })).status,
      400,
    );
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restart during a read outage preserves auto intent and recovers without a browser", async () => {
  const directory = mkdtempSync(join(tmpdir(), "automation-boot-outage-"));
  const store = createAutomationStateStore({ directory });
  const game = fakeGame();
  let now = 1_000_000;
  let offline = false;
  let started = false;
  let timers = [];
  let service;
  const make = () =>
    createAutomationService({
      store,
      getBoss: (id) => ({ numericId: id, name: "Boss" }),
      fetcher: async (url, init) => {
        const path = new URL(url).pathname;
        if (offline && path.includes("/bosses/"))
          return Response.json({ error: "maintenance" }, { status: 503 });
        if (path === "/api/bosses/7" && started)
          return Response.json({
            id: 7,
            damageMax: 10,
            activeBattle: battle(now),
            state: { canStartFight: false },
          });
        const response = await game.fetcher(url, init);
        if (path === "/api/bosses/7/battles" && init?.method === "POST")
          started = true;
        return response;
      },
      now: () => now,
      random: () => 0,
      schedule: (callback, delay) => {
        const timer = { callback, at: now + delay, canceled: false };
        timers.push(timer);
        return timer;
      },
      cancel: (timer) => {
        if (timer) timer.canceled = true;
      },
    });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  try {
    service = make();
    const entry = await openBoss(service);
    await service.command(
      entry,
      command("boot-outage-start", "start", service.snapshot(entry).version),
    );
    await service.command(
      entry,
      command(
        "boot-outage-auto",
        "auto.start",
        service.snapshot(entry).version,
      ),
    );
    assert.equal(store.read("101").auto.enabled, true);
    service.close();
    timers = [];
    offline = true;
    service = make();
    await service.boot();
    assert.equal(store.read("101").auto.enabled, true);
    assert.equal(store.read("101").auto.phase, "waiting");
    assert.equal(
      game.calls.filter((call) => call.path.endsWith("/attack")).length,
      0,
    );
    offline = false;
    for (let i = 0; i < 3; i++) {
      const timer = timers.find((item) => !item.canceled);
      assert.ok(timer, "recovery remains scheduled");
      timer.canceled = true;
      now = Math.max(now, timer.at);
      timer.callback();
      await flush();
      if (game.calls.some((call) => call.path.endsWith("/attack"))) break;
    }
    assert.equal(
      game.calls.filter((call) => call.path.endsWith("/attack")).length,
      1,
    );
  } finally {
    service?.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stop while a strike is queued prevents its later dispatch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "automation-queued-stop-"));
  const store = createAutomationStateStore({ directory });
  const game = fakeGame();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const service = createAutomationService({
    store,
    getBoss: (id) => ({ numericId: id, name: "Boss" }),
    now: () => 1_000_000,
    fetcher: async (url, init) => {
      if (new URL(url).pathname === "/api/bosses/invitations") {
        await gate;
        return Response.json({ items: [] });
      }
      return game.fetcher(url, init);
    },
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  try {
    const entry = await openBoss(service);
    await service.command(
      entry,
      command("queue-stop-start", "start", service.snapshot(entry).version),
    );
    const reading = service.command(
      entry,
      command(
        "queue-stop-read",
        "invitations.refresh",
        service.snapshot(entry).version,
      ),
    );
    await flush();
    const attack = entry.controller.attack();
    await flush();
    assert.equal(entry.controller.getSnapshot().pending, "attack");
    await service.command(
      entry,
      command("queue-stop-stop", "auto.stop", service.snapshot(entry).version),
    );
    release();
    await Promise.all([reading, attack]);
    assert.equal(
      game.calls.some((call) => call.path.endsWith("/attack")),
      false,
    );
  } finally {
    release();
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a heartbeat failure in one account cannot disable another account or erase its own intent", async () => {
  await withContext(async ({ service }) => {
    const first = await service.identify(tokenA);
    const other = await service.identify(tokenB);
    let otherTicks = 0;
    first.collector.tick = () => {
      throw new TypeError("malformed account response");
    };
    other.workFarm.tick = () => {
      otherTicks++;
    };
    await service.boot();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(first.storageFailed, false);
    assert.equal(other.storageFailed, false);
    assert.ok(otherTicks > 0);
    await service.command(
      other,
      command(
        "heartbeat-favorite",
        "favorites.set",
        service.snapshot(other).version,
        { bossIds: [7] },
      ),
    );
    assert.deepEqual(service.snapshot(other).preferences.favoriteBossIds, [7]);
  });
});

test("a solo goal can replace completed invitation mode, while uncertain checkpoints remain protected", async () => {
  for (const uncertain of [false, true]) {
    await withContext(async ({ service, game }) => {
      const entry = await service.identify(tokenA);
      entry.controller.restoreState({
        boss: { id: 7, name: "Boss" },
        battle: {
          id: "old-invitation",
          status: "won",
          detailsLoaded: true,
          rewardKnown: true,
        },
        invitationOnly: true,
        purchaseUncertain: uncertain,
      });
      const input = command(
        `solo-after-raid-${uncertain}`,
        "auto.start",
        service.snapshot(entry).version,
        {
          settings: {
            bossId: 7,
            kind: "battles",
            targetCount: 2,
            maxAttempts: 2,
          },
        },
      );
      if (uncertain) {
        await assert.rejects(
          service.command(entry, input),
          /automation_start_unavailable/,
        );
        assert.equal(service.snapshot(entry).battle.invitationOnly, true);
        assert.equal(service.snapshot(entry).battle.purchaseUncertain, true);
      } else {
        await service.command(entry, input);
        assert.equal(service.snapshot(entry).battle.invitationOnly, false);
        assert.equal(service.snapshot(entry).auto.enabled, true);
      }
      assert.equal(
        game.calls.filter((call) => call.method === "POST").length,
        0,
      );
    });
  }
});

test("adopted bridge credentials are stored on the actor only for a matching verified auth operation", async () => {
  await withContext(async ({ store, service, game }) => {
    const ownerId = "7654321";
    const playerId = "101";
    const operationId = "00000000-0000-4000-8000-000000000123";
    store.bindVerifiedGameAccount(ownerId, playerId, 1_000_000);
    store.selectRoutePolicy(playerId, {
      policy: "bridge_required",
      activeDeviceId: "00000000-0000-4000-8000-000000000001",
      expectedRouteEpoch: 0,
      updatedAt: 1_000_000,
    });
    let recovery = {
      schemaVersion: 1,
      ownerId,
      playerId,
      operationId,
      authGeneration: 1,
      consentGeneration: 4,
      routeEpoch: 1,
      state: "created",
      expectedCredentialVersion: 0,
      credentialVersion: null,
      updatedAt: 1_000_001,
    };
    store.startGameAuthRecovery(recovery);
    for (const state of [
      "launch_requested",
      "exchange_pending",
      "verification_pending",
    ]) {
      recovery = store.updateGameAuthRecovery(ownerId, operationId, {
        ...recovery,
        state,
        updatedAt: recovery.updatedAt + 1,
      });
    }
    store.updateGameAuthRecovery(ownerId, operationId, {
      ...recovery,
      state: "credential_stored",
      credentialVersion: 1,
      updatedAt: recovery.updatedAt + 1,
    });

    const profile = { telegramId: Number(ownerId), playerId: Number(playerId) };
    await service.adoptGameCredential({
      ownerId,
      playerId,
      authOperationId: operationId,
      authGeneration: 1,
      consentGeneration: 4,
      routeEpoch: 1,
      credentialVersion: 1,
      accessToken: "tokenC.payload.sig",
      profile,
    });
    const adoptedRecovery = store.readGameAuthRecovery(ownerId);
    store.updateGameAuthRecovery(ownerId, operationId, {
      ...adoptedRecovery,
      state: "ready",
      updatedAt: adoptedRecovery.updatedAt + 1,
    });
    assert.equal(store.read(playerId).credential, "Bearer tokenC.payload.sig");
    assert.deepEqual(game.calls, []);
    const cached = await service.identify("Bearer tokenC.payload.sig");
    assert.equal(cached.player.playerId, Number(playerId));
    assert.deepEqual(game.calls, []);

    await assert.rejects(
      service.adoptGameCredential({
        ownerId,
        playerId,
        authOperationId: "00000000-0000-4000-8000-000000000124",
        authGeneration: 1,
        consentGeneration: 4,
        routeEpoch: 1,
        credentialVersion: 1,
        accessToken: "other.payload.sig",
        profile,
      }),
      { status: 409 },
    );
  });
});

test("route change while actor restoration yields prevents late credential adoption", async () => {
  await withContext(async ({ store, service }) => {
    const ownerId = "7654321";
    const playerId = "101";
    const operationId = "00000000-0000-4000-8000-000000000123";
    store.bindVerifiedGameAccount(ownerId, playerId, 1_000_000);
    store.selectRoutePolicy(playerId, {
      policy: "bridge_required",
      activeDeviceId: "00000000-0000-4000-8000-000000000001",
      expectedRouteEpoch: 0,
      updatedAt: 1_000_000,
    });
    let recovery = {
      schemaVersion: 1,
      ownerId,
      playerId,
      operationId,
      authGeneration: 1,
      consentGeneration: 4,
      routeEpoch: 1,
      state: "created",
      expectedCredentialVersion: 0,
      credentialVersion: null,
      updatedAt: 1_000_001,
    };
    store.startGameAuthRecovery(recovery);
    for (const state of [
      "launch_requested",
      "exchange_pending",
      "verification_pending",
    ]) {
      recovery = store.updateGameAuthRecovery(ownerId, operationId, {
        ...recovery,
        state,
        updatedAt: recovery.updatedAt + 1,
      });
    }
    store.updateGameAuthRecovery(ownerId, operationId, {
      ...recovery,
      state: "credential_stored",
      credentialVersion: 1,
      updatedAt: recovery.updatedAt + 1,
    });

    const adoption = service.adoptGameCredential({
      ownerId,
      playerId,
      authOperationId: operationId,
      authGeneration: 1,
      consentGeneration: 4,
      routeEpoch: 1,
      credentialVersion: 1,
      accessToken: "late.payload.sig",
      profile: { telegramId: Number(ownerId), playerId: Number(playerId) },
    });
    store.selectRoutePolicy(playerId, {
      policy: "direct",
      activeDeviceId: null,
      expectedRouteEpoch: 1,
      updatedAt: 1_000_002,
    });

    await assert.rejects(adoption, { status: 409 });
    assert.equal(store.read(playerId)?.credential ?? null, null);
  });
});
