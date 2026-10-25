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

function fakeGame({ now = 1_000_000 } = {}) {
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
        activeBattle: null,
        state: { canStartFight: true },
      });
    if (
      url.pathname === "/api/bosses/battles/battle-1" &&
      (init.method || "GET") === "GET"
    )
      return Response.json(currentBattle || battle(now));
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
    now += 1_000;
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

test("time goal enforces its server deadline before every POST and survives restart without resetting duration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "automation-time-deadline-"));
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
      command("time-start", "start", service.snapshot(entry).version),
    );
    await service.command(
      entry,
      command("time-goal", "goal.configure", service.snapshot(entry).version, {
        bossId: 7,
        kind: "time",
        durationHours: 1,
      }),
    );
    assert.equal(service.snapshot(entry).goal.deadlineAt, started + 3600000);
    clock = started + 3599000;
    await service.command(
      entry,
      command("time-hit1", "attack", service.snapshot(entry).version),
    );
    assert.equal(posts, 2);
    clock = started + 3600000;
    await service.command(
      entry,
      command("time-hit2", "attack", service.snapshot(entry).version),
    );
    assert.equal(posts, 2);
    assert.equal(service.snapshot(entry).goal.status, "completed");
    service.close();
    service = create();
    entry = await service.identify(tokenA);
    assert.equal(service.snapshot(entry).goal.deadlineAt, started + 3600000);
    assert.equal(service.snapshot(entry).goal.status, "completed");
    assert.equal(posts, 2);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
