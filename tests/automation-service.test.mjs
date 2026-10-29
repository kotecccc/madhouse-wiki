import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAutomationHttp } from "../scripts/automation/http.mjs";
import { createAutomationService } from "../scripts/automation/service.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";

const tokenA = "Bearer tokenA.payload.sig";
const tokenARotated = "Bearer tokenA2.payload.sig";
const tokenB = "Bearer tokenB.payload.sig";

test("queue move is durable and repeating its receipt does not move twice", async () => {
  await withContext(async ({ service, store, game }) => {
    const entry = await service.identify(tokenA);
    for (const [id, bossId] of [
      ["queue-boss-one", 7],
      ["queue-boss-two", 8],
    ]) {
      await service.command(entry, {
        id,
        command: "queue.enqueue",
        expectedVersion: service.snapshot(entry).version,
        args: {
          type: "auto.start",
          action: {
            settings: {
              bossId,
              kind: "battles",
              targetCount: 1,
              durationHours: null,
            },
          },
        },
      });
    }
    const command = {
      id: "move-boss-two",
      command: "queue.move",
      expectedVersion: service.snapshot(entry).version,
      args: { id: "queue-boss-two", direction: "up" },
    };
    await service.command(entry, command);
    await service.command(entry, command);
    const jobs = store.read("101").queuedActions;
    assert.ok(
      jobs.find((job) => job.id === "queue-boss-two").queueOrderAt <
        jobs.find((job) => job.id === "queue-boss-one").queueOrderAt,
    );
    assert.ok(store.read("101").receipts.includes(command.id));
    assert.equal(
      game.calls.filter(({ method }) => method === "POST").length,
      0,
    );
  });
});

test("stored state reads survive a game credential outage without refreshing the game", async () => {
  await withContext(
    async ({ service, game }) => {
      await service.identify(tokenA);
      game.calls.length = 0;

      const entry = await service.readStored(tokenA);
      const saved = service.snapshot(entry);
      assert.ok(saved.preferences);
      assert.equal(game.calls.length, 0);

      await assert.rejects(
        service.readStored(tokenB),
        (error) =>
          error.status === 404 && error.message === "automation_state_unknown",
      );
      assert.equal(game.calls.length, 0);
    },
    { accountHealth: () => ({ status: "credentials_invalid" }) },
  );
});

test("stored automation state reports only the owner's unresolved bridge attempts without game traffic", async () => {
  await withContext(async ({ service, store, game }) => {
    await service.identify(tokenA);
    game.calls.length = 0;
    for (const [id, playerId] of [
      ["00000000-0000-4000-8000-000000000001", "101"],
      ["00000000-0000-4000-8000-000000000002", "202"],
    ]) {
      store.createBridgeAttempt({
        id,
        playerId,
        operationId: "operation_1",
        deviceId: "00000000-0000-4000-8000-000000000003",
        bindingRevision: 1,
        deviceGeneration: 1,
        action: "mutation",
        phase: "uncertain",
        createdAt: 1,
        updatedAt: 1,
      });
    }
    const entry = await service.readStored(tokenA);
    assert.deepEqual(service.snapshot(entry).recovery, {
      status: "unresolved",
      reason: "bridge_attempt_unconfirmed",
      pending: 1,
      autoCheck: false,
    });
    store.readActiveBridgeAttempts = () => {
      throw new Error("storage unavailable");
    };
    assert.deepEqual(service.snapshot(entry).recovery, {
      status: "unavailable",
      autoCheck: false,
    });
    assert.equal(game.calls.length, 0);
  });
});

test("queue.cancel reports unavailable storage instead of acknowledging a failed write", async () => {
  await withContext(async ({ service, store }) => {
    const entry = await service.identify(tokenA);
    await service.command(entry, {
      id: "storage-queued-job",
      command: "queue.enqueue",
      expectedVersion: service.snapshot(entry).version,
      args: {
        type: "friend.favorite",
        action: { playerId: 10, enabled: false },
      },
    });
    store.write = () => {
      throw new Error("disk unavailable");
    };
    await assert.rejects(
      service.command(entry, {
        id: "storage-cancel-test",
        command: "queue.cancel",
        expectedVersion: service.snapshot(entry).version,
        args: { id: "storage-queued-job" },
      }),
      (error) =>
        error.status === 503 &&
        error.message === "automation_storage_unavailable",
    );
  });
});

test("queue.cancel uses stored actor state without game identification", async () => {
  const actor = { id: "stored" };
  let identifications = 0;
  const http = createAutomationHttp({
    service: {
      readStored: async () => actor,
      identify: async () => {
        identifications++;
        throw new Error("game unavailable");
      },
      command: async (entry, command) => ({
        actor: entry.id,
        command: command.command,
      }),
    },
  });
  const response = await http(
    new Request("https://wiki.test/api/automation/commands", {
      method: "POST",
      headers: { authorization: tokenA, "content-type": "application/json" },
      body: JSON.stringify({
        id: "cancel-test",
        command: "queue.cancel",
        args: { id: "job-1" },
      }),
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    actor: "stored",
    command: "queue.cancel",
  });
  assert.equal(identifications, 0);
});

function battle(now, id = "battle-1", status = "active", bossHealth = 40) {
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
    myDamage: 60,
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
              Response.json({ battle: battle(now, "battle-1", "won", 0) }),
            );
        });
      currentBattle = battle(now, "battle-1", "won", 0);
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
    ...(options.accountHealth ? { accountHealth: options.accountHealth } : {}),
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

test("service persists the schema migration and preserves legacy checkpoints", async () => {
  await withContext(async ({ store, service }) => {
    const pending = {
      id: "pending-invitation",
      kind: "invitation",
      operationId: "accepted-once",
      battleId: "battle-1",
    };
    await store.write(101, {
      version: 4,
      credential: tokenA,
      player: { playerId: 101, nickname: "Alice" },
      manualBattle: { pending, receipts: [] },
    });

    await service.identify(tokenA);
    const migrated = await store.read(101);
    assert.equal(migrated.schemaVersion, 1);
    assert.deepEqual(migrated.manualBattle.pending, pending);
  });
});

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

test("queued intentions and receipts stay isolated through token rotation and server restart", async () => {
  await withContext(async ({ store, service, game, now }) => {
    const first = await service.identify(tokenA);
    const other = await service.identify(tokenB);
    const enqueue = (entry, playerId) =>
      service.command(entry, {
        id: "shared-command-id",
        command: "queue.enqueue",
        expectedVersion: service.snapshot(entry).version,
        args: {
          type: "friend.favorite",
          action: { playerId, enabled: false, secret: "do-not-persist" },
        },
      });
    await enqueue(first, 11);
    await enqueue(other, 22);
    const rotated = await service.identify(tokenARotated);
    assert.equal(rotated, first);
    assert.equal(store.read("101").queuedActions[0].args.playerId, 11);
    assert.equal(store.read("202").queuedActions[0].args.playerId, 22);
    assert.ok(store.read("101").receipts.includes("shared-command-id"));
    assert.ok(store.read("202").receipts.includes("shared-command-id"));
    assert.ok(
      !JSON.stringify(service.snapshot(rotated)).includes("do-not-persist"),
    );
    service.close();
    const restored = createAutomationService({
      store,
      fetcher: game.fetcher,
      getBoss: (id) => ({ numericId: id, name: "Boss" }),
      now: () => now,
      random: () => 0,
      schedule: () => ({ unref() {} }),
      cancel: () => {},
    });
    try {
      const firstAfter = await restored.identify(tokenARotated);
      const otherAfter = await restored.identify(tokenB);
      const firstView = restored.snapshot(firstAfter);
      const otherView = restored.snapshot(otherAfter);
      assert.equal(firstView.queuedActions[0].args.playerId, 11);
      assert.equal(otherView.queuedActions[0].args.playerId, 22);
      assert.equal(
        firstView.queuedActions[0].id,
        otherView.queuedActions[0].id,
      );
      const duplicate = await restored.command(firstAfter, {
        id: "shared-command-id",
        command: "queue.enqueue",
        expectedVersion: firstView.version,
        args: {
          type: "friend.favorite",
          action: { playerId: 11, enabled: false },
        },
      });
      assert.equal(duplicate.queuedActions.length, 1);
      for (const snapshot of [firstView, otherView])
        assert.doesNotMatch(
          JSON.stringify(snapshot),
          /tokenA|tokenB|do-not-persist/,
        );
      assert.ok(game.calls.every((call) => call.method === "GET"));
    } finally {
      restored.close();
    }
  });
});

test("state reads use the stored identity without additional game calls", async () => {
  await withContext(async ({ service, game }) => {
    await service.identify(tokenA);
    const countAfterIdentity = game.calls.length;
    const http = createAutomationHttp({ service, enabled: true });
    const request = () =>
      http(
        new Request("https://wiki.test/api/automation/state", {
          headers: { authorization: tokenA },
        }),
      );
    assert.equal((await request()).status, 200);
    assert.equal((await request()).status, 200);
    assert.equal(game.calls.length, countAfterIdentity);
    assert.equal(game.calls.filter(({ path }) => path === "/api/me").length, 1);
  });
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
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === "/api/me") return Response.json({ playerId: 101 });
    if (path === "/api/combat") return Response.json({ activeBattle: null });
    if (path === "/api/bosses/7")
      return Response.json({
        id: 7,
        state: { canStartFight: true },
        activeBattle: null,
      });
    const raw = {
      ...battle(clock),
      expiresAtUtc: new Date(started + 24 * 3600000).toISOString(),
    };
    if (init.method === "POST") {
      posts++;
      return Response.json({ battle: raw });
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
      service.reconcileStored(entry);
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
