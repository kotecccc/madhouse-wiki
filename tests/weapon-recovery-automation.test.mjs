import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutomationService } from "../scripts/automation/service.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";
import { inventoryGame } from "./helpers/inventory-game.mjs";

async function context(
  {
    pills,
    raid = false,
    failedAttack = 409,
    failRepair = false,
    holdInventoryRead = false,
  },
  run,
) {
  const directory = mkdtempSync(join(tmpdir(), "weapon-auto-recovery-"));
  const store = createAutomationStateStore({ directory });
  let clock = 1000000,
    joined = !raid,
    successes = 0;
  const timers = [],
    attacks = [];
  let held = false,
    releaseRead;
  const heldRead = new Promise((resolve) => {
    releaseRead = resolve;
  });
  const game = inventoryGame({
    owned: true,
    equipped: true,
    broken: true,
    pills,
    cost: 100,
    failMutation: failRepair,
    beforeMutation: () =>
      assert.ok(
        store.list()[0]?.value.equipment.pending,
        "equipment checkpoint is durable before remediation",
      ),
  });
  const battle = () => ({
    battleId: "fight-1",
    bossId: 7,
    status: "active",
    serverTimeUtc: new Date(clock).toISOString(),
    cooldownUntilUtc: new Date(clock + (successes ? 1000 : 0)).toISOString(),
    expiresAtUtc: new Date(clock + 120000).toISOString(),
    playerHealth: 100,
    playerMaxHealth: 100,
    bossHealth: 1000 - successes * 10,
    bossMaxHealth: 1000,
    myDamage: successes * 10,
    participantCount: 1,
    participants: [{ playerId: 17, nickname: "Fake" }],
    actions: [],
  });
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname,
      method = init.method || "GET";
    if (path === "/api/me")
      return Response.json({
        playerId: 17,
        wallet: game.wallet,
        activeBossBattle: joined ? { battleId: "fight-1", bossId: 7 } : null,
      });
    if (path === "/api/me/bag")
      return Response.json({ combatItems: [], activityItems: [] });
    if (path === "/api/bosses/7")
      return Response.json({
        id: 7,
        damageMax: 10,
        activeBattle: joined ? battle() : null,
        state: { canStartFight: true },
      });
    if (path === "/api/bosses/battles/fight-1" && method === "GET")
      return Response.json(battle());
    if (path === "/api/bosses/invitations")
      return Response.json({
        items: [
          {
            invitationId: "invite-1",
            battleId: "fight-1",
            bossId: 7,
            status: "pending",
            battleStatus: "active",
            expiresAtUtc: new Date(clock + 120000).toISOString(),
            battleExpiresAtUtc: new Date(clock + 120000).toISOString(),
          },
        ],
      });
    if (path === "/api/bosses/invitations/invite-1/accept") {
      joined = true;
      return Response.json({ success: true });
    }
    if (path === "/api/bosses/battles/fight-1/attack") {
      attacks.push(JSON.parse(init.body).operationId);
      if (game.items.weapon.equipped && game.items.weapon.durability.isBroken)
        return Response.json(
          { error: "weapon_broken" },
          { status: failedAttack },
        );
      successes++;
      return Response.json({
        battle: battle(),
        hits: [{ actor: "player", damage: 10 }],
      });
    }
    if (holdInventoryRead && path === "/api/clothing/by-category/1" && !held) {
      held = true;
      await heldRead;
    }
    return game.fetcher(url, init);
  };
  const makeService = () =>
    createAutomationService({
      store,
      getBoss: (id) => ({ numericId: id, name: "Fake boss" }),
      fetcher,
      identifyPlayer: async () => ({ playerId: 17 }),
      now: () => clock,
      random: () => 0,
      schedule: (callback, delay) => {
        const timer = {
          callback,
          at: clock + delay,
          cancelled: false,
          fired: false,
        };
        timers.push(timer);
        return timer;
      },
      cancel: (timer) => {
        if (timer) timer.cancelled = true;
      },
    });
  let service = makeService();
  let entry = await service.identify("Bearer fake-token");
  let receipt = 0;
  const command = (name, args = {}) =>
    service.command(entry, {
      id: `command-${++receipt}`,
      command: name,
      expectedVersion: service.snapshot(entry).version,
      args,
    });
  const flush = async () => {
    for (let i = 0; i < 3; i++)
      await new Promise((resolve) => setImmediate(resolve));
  };
  const tick = async () => {
    const timer = timers
      .filter((timer) => !timer.cancelled && !timer.fired)
      .sort((a, b) => a.at - b.at)[0];
    if (!timer) return false;
    timer.fired = true;
    clock = Math.max(clock, timer.at);
    timer.callback();
    await flush();
    return true;
  };
  try {
    await command("open", { bossId: 7 });
    if (raid) {
      await command("raid.start", {
        settings: {
          bossId: 7,
          kind: "battles",
          targetCount: 2,
          maxAttempts: 3,
        },
      });
      await entry.raidWorker.tick();
    } else await command("auto.start");
    await flush();
    await run({
      entry,
      service,
      store,
      game,
      attacks,
      tick,
      flush,
      successes: () => successes,
      command,
      releaseRead,
      readHeld: () => held,
      restart: async () => {
        service.close();
        service = makeService();
        await service.boot();
        entry = await service.identify("Bearer fake-token");
        await flush();
        return { service, entry };
      },
    });
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
for (const raid of [false, true])
  for (const pills of [5001, 5000])
    test(`${raid ? "raid" : "autobattle"} repairs above reserve or removes at reserve and keeps attacking`, async () => {
      await context(
        { pills, raid },
        async ({ service, entry, game, attacks, tick, successes }) => {
          for (let i = 0; i < 6 && game.mutations().length === 0; i++)
            assert.equal(await tick(), true);
          assert.equal(game.mutations().length, 1);
          assert.equal(
            game.mutations()[0].method,
            pills > 5000 ? "POST" : "DELETE",
          );
          assert.equal(service.snapshot(entry).auto.enabled, true);
          assert.equal(service.snapshot(entry).battle.needsRefresh, false);
          assert.equal(service.snapshot(entry).equipment.pending, null);
          if (raid) assert.equal(service.snapshot(entry).raid.enabled, true);
          for (let i = 0; i < 6 && successes() === 0; i++)
            assert.equal(await tick(), true);
          assert.ok(
            successes() > 0,
            "new regular strike continues after confirmed maintenance",
          );
          assert.equal(
            new Set(attacks).size,
            attacks.length,
            "a rejected attack receipt is never replayed",
          );
          assert.equal(game.mutations().length, 1);
        },
      );
    });
test("server failures do not trigger repairs or automatic replays", async () => {
  await context(
    { pills: 10000, failedAttack: 503 },
    async ({ game, attacks, tick }) => {
      for (let i = 0; i < 3 && attacks.length === 0; i++) await tick();
      assert.equal(attacks.length, 1);
      assert.equal(game.mutations().length, 0);
    },
  );
});
test("an uncertain automatic repair stays durable and cannot be resubmitted on restart", async () => {
  await context(
    { pills: 10000, failRepair: true },
    async ({ service, entry, store, game, attacks, tick, restart }) => {
      for (let i = 0; i < 4 && game.mutations().length === 0; i++) await tick();
      assert.ok(store.list()[0].value.equipment.pending);
      assert.equal(game.mutations().length, 1);
      const saved = store.list()[0].value;
      assert.ok(saved.assistant.pending);
      assert.equal(service.snapshot(entry).equipment.pending.action, "repair");
      const restored = await restart();
      assert.ok(restored.service.snapshot(restored.entry).equipment.pending);
      for (let i = 0; i < 2; i++) await tick();
      assert.equal(game.mutations().length, 1);
      assert.equal(attacks.length, 1);
    },
  );
});

test("user stop while maintenance is reading prevents a late repair/removal", async () => {
  await context(
    { pills: 10000, holdInventoryRead: true },
    async ({
      game,
      tick,
      readHeld,
      releaseRead,
      command,
      flush,
      service,
      entry,
    }) => {
      for (let i = 0; i < 3 && !readHeld(); i++) await tick();
      assert.equal(readHeld(), true);
      await command("auto.stop");
      releaseRead();
      await flush();
      assert.equal(game.mutations().length, 0);
      assert.equal(service.snapshot(entry).auto.enabled, false);
    },
  );
});
