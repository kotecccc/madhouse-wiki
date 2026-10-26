import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  projectBossInvitations,
  BOSS_INVITATIONS_PATH,
} from "../scripts/automation/boss-invitations.mjs";
import { createAutomationService } from "../scripts/automation/service.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";

const token = "Bearer invitations.token.sig";
const now = 1_000_000;
const future = new Date(now + 60_000).toISOString();

test("invitation projection filters invalid records, deduplicates and limits public fields", async () => {
  const raw = {
    items: [
      {
        invitationId: "invite-1",
        battleId: "battle-1",
        bossId: 7,
        status: "pending",
        battleStatus: "active",
        expiresAtUtc: future,
        battleExpiresAtUtc: future,
        peerNickname: " Alice ",
        private: "secret",
      },
      {
        invitationId: "invite-1",
        battleId: "battle-2",
        bossId: 8,
        status: "pending",
        battleStatus: "active",
        expiresAtUtc: future,
        battleExpiresAtUtc: future,
      },
      {
        invitationId: "bad/id",
        battleId: "battle-3",
        bossId: 7,
        status: "pending",
        battleStatus: "active",
        expiresAtUtc: future,
        battleExpiresAtUtc: future,
      },
      {
        invitationId: "closed",
        battleId: "battle-4",
        bossId: 7,
        status: "accepted",
        battleStatus: "active",
        expiresAtUtc: future,
        battleExpiresAtUtc: future,
      },
    ],
  };
  const projected = await projectBossInvitations(
    raw,
    (id) => ({ name: `Boss ${id}` }),
    now,
  );
  assert.deepEqual(projected, [
    {
      invitationId: "invite-1",
      battleId: "battle-2",
      bossId: 8,
      bossName: "Boss 8",
      sender: "Отправитель не указан",
      expiresAt: now + 60_000,
      available: true,
    },
  ]);
  assert.equal(JSON.stringify(projected).includes("secret"), false);
  await assert.rejects(
    projectBossInvitations({}, () => null, now),
    /invalid_boss_invitations/,
  );
});

function invitationBattle(
  id = "battle-9",
  participants = [{ playerId: 101, nickname: "Alice" }],
) {
  return {
    battleId: id,
    bossId: 7,
    status: "active",
    serverTimeUtc: new Date(now).toISOString(),
    cooldownUntilUtc: new Date(now).toISOString(),
    expiresAtUtc: future,
    retryAfterMilliseconds: 0,
    playerHealth: 80,
    playerMaxHealth: 100,
    bossHealth: 40,
    bossMaxHealth: 100,
    myDamage: 0,
    participantCount: participants.length,
    participants,
    actions: [],
  };
}

function setup(directory, options = {}) {
  const store = createAutomationStateStore({ directory });
  const calls = [];
  const pendingBeforePost = [];
  let currentNow = options.now ?? now;
  let ownActiveBattle = options.activeBattle ?? null;
  let accepted = false;
  const fetcher = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = init.method || "GET";
    calls.push({ method, path: url.pathname + url.search });
    if (url.pathname === "/api/me")
      return Response.json({
        playerId: 101,
        nickname: "Alice",
        ...(options.omitActiveBossBattle
          ? {}
          : { activeBossBattle: ownActiveBattle }),
      });
    if (url.pathname === "/api/combat")
      return Response.json({ activeBattle: null });
    if (url.pathname === BOSS_INVITATIONS_PATH.split("?")[0])
      return Response.json({
        items: accepted
          ? []
          : [
              {
                invitationId: "invite-9",
                battleId: "battle-9",
                bossId: 7,
                status: "pending",
                battleStatus: "active",
                expiresAtUtc: future,
                battleExpiresAtUtc: future,
                peerNickname: "Bob",
              },
            ],
      });
    if (url.pathname === "/api/bosses/7")
      return accepted && options.bossSummaryUnavailable
        ? new Response(null, { status: 503 })
        : Response.json({
            id: accepted ? (options.bossSummaryId ?? 7) : 7,
            damageMax: 10,
            ...((
              accepted
                ? (options.omitBossActiveBattleAfterAccept ??
                  options.omitBossActiveBattle)
                : options.omitBossActiveBattle
            )
              ? {}
              : {
                  activeBattle:
                    accepted && options.detailActiveBattle !== undefined
                      ? options.detailActiveBattle
                      : null,
                }),
            state: { canStartFight: true },
          });
    if (
      url.pathname === "/api/bosses/invitations/invite-9/accept" &&
      method === "POST"
    ) {
      const saved = store.read("101");
      pendingBeforePost.push(saved?.battle?.pendingInvitation ?? null);
      accepted = true;
      if (options.timeoutPost) throw new Error("simulated timeout");
      return new Response(null, { status: 204 });
    }
    if (
      url.pathname === "/api/bosses/battles/battle-9/attack" &&
      method === "POST"
    )
      return Response.json(invitationBattle());
    if (url.pathname === "/api/bosses/battles/battle-9")
      return Response.json(
        invitationBattle(
          options.mismatchedBattle ? "other-battle" : "battle-9",
          options.foreignParticipant ? [{ playerId: 202 }] : undefined,
        ),
      );
    return Response.json({ error: "unexpected_fake_route" }, { status: 404 });
  };
  const service = createAutomationService({
    store,
    getBoss: (id) => ({ numericId: id, name: `Boss ${id}` }),
    fetcher,
    now: () => currentNow,
    random: () => 0,
    schedule: () => ({ unref() {} }),
    cancel: () => {},
  });
  return {
    service,
    store,
    calls,
    pendingBeforePost,
    setNow(value) {
      currentNow = value;
    },
    close() {
      service.close();
      store.close();
    },
  };
}

async function issue(service, entry, id, name, args = {}) {
  return service.command(entry, {
    id,
    command: name,
    expectedVersion: service.snapshot(entry).version,
    args,
  });
}

test("accept persists invitation checkpoint before POST and confirms exact battle with own participant", async () => {
  const directory = mkdtempSync(join(tmpdir(), "boss-invitations-test-"));
  const ctx = setup(directory);
  try {
    const entry = await ctx.service.identify(token);
    await issue(ctx.service, entry, "refreshinvite1", "invitations.refresh");
    assert.equal(
      ctx.service.snapshot(entry).invitations.items[0].invitationId,
      "invite-9",
    );
    await issue(ctx.service, entry, "acceptinvite1", "invitations.accept", {
      invitationId: "invite-9",
    });
    assert.deepEqual(ctx.pendingBeforePost, [
      {
        invitationId: "invite-9",
        battleId: "battle-9",
        bossId: 7,
        expiresAt: now + 60_000,
      },
    ]);
    const snapshot = ctx.service.snapshot(entry);
    assert.equal(snapshot.battle.battle.id, "battle-9");
    assert.equal(snapshot.battle.invitationOnly, true);
    assert.equal(snapshot.battle.pendingInvitation, null);
    assert.equal(
      ctx.calls.some((call) => call.path === "/api/bosses/battles/battle-9"),
      true,
    );
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("timed out accept remains checkpointed across restart and refresh never repeats POST", async () => {
  const directory = mkdtempSync(join(tmpdir(), "boss-invitations-restart-"));
  let ctx = setup(directory, { timeoutPost: true });
  try {
    let entry = await ctx.service.identify(token);
    await assert.rejects(
      issue(ctx.service, entry, "timeoutinv1", "invitations.accept", {
        invitationId: "invite-9",
      }),
    );
    assert.ok(ctx.store.read("101")?.battle?.pendingInvitation);
    assert.equal(ctx.calls.filter((call) => call.method === "POST").length, 1);
    ctx.close();
    ctx = setup(directory);
    entry = await ctx.service.identify(token);
    await issue(ctx.service, entry, "refreshafter1", "invitations.refresh");
    assert.equal(ctx.calls.filter((call) => call.method === "POST").length, 0);
    assert.equal(ctx.service.snapshot(entry).battle.pendingInvitation, null);
    assert.equal(ctx.service.snapshot(entry).battle.battle.id, "battle-9");
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("expired uncertain accept uses validated own boss summary when me omits active battle", async (t) => {
  const cases = [
    {
      name: "explicit own no-battle summary clears",
      options: {},
      clears: true,
    },
    {
      name: "wrong boss summary keeps checkpoint",
      options: { bossSummaryId: 8 },
    },
    {
      name: "unknown own boss summary keeps checkpoint",
      options: { omitBossActiveBattleAfterAccept: true },
    },
    {
      name: "active own boss battle keeps checkpoint",
      options: { detailActiveBattle: { battleId: "battle-9", bossId: 7 } },
    },
    {
      name: "boss summary outage keeps checkpoint",
      options: { bossSummaryUnavailable: true },
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const directory = mkdtempSync(
        join(tmpdir(), "boss-invitations-expired-"),
      );
      const ctx = setup(directory, {
        timeoutPost: true,
        omitActiveBossBattle: true,
        mismatchedBattle: true,
        ...scenario.options,
      });
      try {
        const entry = await ctx.service.identify(token);
        await assert.rejects(
          issue(
            ctx.service,
            entry,
            `timeout-${scenario.name.replaceAll(" ", "-")}`,
            "invitations.accept",
            {
              invitationId: "invite-9",
            },
          ),
        );
        assert.ok(ctx.service.snapshot(entry).battle.pendingInvitation);
        ctx.setNow(now + 60_001);
        await issue(
          ctx.service,
          entry,
          `refresh-${scenario.name.replaceAll(" ", "-")}`,
          "invitations.refresh",
        );
        assert.equal(
          ctx.service.snapshot(entry).battle.pendingInvitation === null,
          scenario.clears === true,
        );
        assert.equal(
          ctx.calls.filter((call) => call.method === "POST").length,
          1,
        );
        assert.ok(
          ctx.calls.some(
            (call) => call.method === "GET" && call.path === "/api/bosses/7",
          ),
          "fallback reads the expected boss summary",
        );
      } finally {
        ctx.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

test("active battle blocks accepting another invitation and invalid ID makes no upstream request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "boss-invitations-guards-"));
  const ctx = setup(directory, {
    activeBattle: { battleId: "other-battle", bossId: 8 },
  });
  try {
    const entry = await ctx.service.identify(token);
    const before = ctx.calls.length;
    await assert.rejects(
      issue(ctx.service, entry, "invalidinvite1", "invitations.accept", {
        invitationId: "../bad",
      }),
    );
    assert.equal(ctx.calls.length, before);
    await assert.rejects(
      issue(ctx.service, entry, "activeinvite1", "invitations.accept", {
        invitationId: "invite-9",
      }),
    );
    assert.equal(
      ctx.calls.some((call) => call.method === "POST"),
      false,
    );
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("accept is not confirmed when upstream battle omits the current player", async () => {
  const directory = mkdtempSync(join(tmpdir(), "boss-invitations-membership-"));
  const ctx = setup(directory, { foreignParticipant: true });
  try {
    const entry = await ctx.service.identify(token);
    await assert.rejects(
      issue(ctx.service, entry, "foreigninvite1", "invitations.accept", {
        invitationId: "invite-9",
      }),
    );
    assert.ok(ctx.service.snapshot(entry).battle.pendingInvitation);
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("accept is not confirmed when response identifies a different battle", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "boss-invitations-exact-battle-"),
  );
  const ctx = setup(directory, { mismatchedBattle: true });
  try {
    const entry = await ctx.service.identify(token);
    await assert.rejects(
      issue(ctx.service, entry, "mismatchinvite1", "invitations.accept", {
        invitationId: "invite-9",
      }),
    );
    assert.ok(ctx.service.snapshot(entry).battle.pendingInvitation);
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

const raidSettings = {
  bossId: 7,
  kind: "battles",
  targetCount: 5,
  countWins: true,
  durationHours: 1,
};

test("raid command persists waiting intent, accepts with checkpoint, and blocks competing actions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raid-service-"));
  const ctx = setup(directory, { omitActiveBossBattle: true });
  try {
    const entry = await ctx.service.identify(token);
    await entry.controller.open({ numericId: 7, name: "Boss 7" });
    await issue(ctx.service, entry, "start-raid-01", "raid.start", {
      settings: raidSettings,
    });
    assert.equal(ctx.store.read("101").raid.status, "waiting");
    assert.equal(
      ctx.calls.some((call) => call.method === "POST"),
      false,
    );
    await assert.rejects(
      issue(ctx.service, entry, "compete-raid-01", "start"),
      /raid_controls_the_battle/,
    );
    await issue(ctx.service, entry, "compete-raid-02", "work.start", {
      workId: 7,
      targetCycles: 1,
      mode: "energy",
      maxActions: 10,
      maxBoosters: 0,
      maxDollar: 0,
      allowPurchase: false,
    });
    assert.equal(ctx.service.snapshot(entry).workFarm.run.status, "running");
    await entry.raidWorker.tick();
    const state = ctx.service.snapshot(entry);
    assert.equal(state.raid.status, "fighting");
    assert.equal(state.auto.enabled, true);
    assert.equal(state.battle.invitationOnly, true);
    assert.equal(ctx.pendingBeforePost.length, 1);
    assert.equal(
      ctx.calls.filter(
        (call) => call.path.endsWith("/accept") && call.method === "POST",
      ).length,
      1,
    );
    assert.equal(
      ctx.calls.some((call) => call.path === "/api/bosses/7/battles"),
      false,
    );
    await issue(ctx.service, entry, "stop-raid-01", "raid.stop");
    assert.equal(ctx.service.snapshot(entry).goal.status, "stopped");
    assert.equal(ctx.service.snapshot(entry).goal.progress, 0);
    assert.equal(ctx.service.snapshot(entry).goal.remainingSeconds, null);
    assert.equal(ctx.service.snapshot(entry).raid.enabled, false);
    assert.equal(ctx.service.snapshot(entry).auto.enabled, false);
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("raid uncertain accept is durable and server restart never replays its POST", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raid-service-restart-"));
  let ctx = setup(directory, { timeoutPost: true });
  try {
    const entry = await ctx.service.identify(token);
    await entry.controller.open({ numericId: 7, name: "Boss 7" });
    await issue(ctx.service, entry, "start-raid-02", "raid.start", {
      settings: raidSettings,
    });
    await entry.raidWorker.tick();
    assert.equal(
      ctx.service.snapshot(entry).raid.status,
      "waiting_confirmation",
    );
    assert.ok(ctx.store.read("101").battle.pendingInvitation);
    ctx.close();
    ctx = setup(directory);
    await ctx.service.boot();
    const restored = await ctx.service.identify(token);
    await restored.raidWorker.tick();
    assert.equal(ctx.service.snapshot(restored).raid.enabled, true);
    assert.equal(ctx.calls.filter((call) => call.method === "POST").length, 0);
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("waiting raid survives service restart without a browser and resumes invitation checks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raid-waiting-restart-"));
  let ctx = setup(directory);
  try {
    let entry = await ctx.service.identify(token);
    await entry.controller.open({ numericId: 7, name: "Boss 7" });
    await issue(ctx.service, entry, "start-raid-03", "raid.start", {
      settings: raidSettings,
    });
    ctx.close();
    ctx = setup(directory);
    await ctx.service.boot();
    // boot loads saved actors before any browser identity/state request.
    assert.equal(ctx.store.read("101").raid.enabled, true);
    assert.equal(
      ctx.calls.some((call) => call.method === "POST"),
      false,
    );
    entry = await ctx.service.identify(token);
    await entry.raidWorker.tick();
    assert.equal(ctx.service.snapshot(entry).raid.status, "fighting");
    await issue(ctx.service, entry, "stop-raid-03", "raid.stop");
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("accept supports current me response without activeBossBattle using explicit boss detail", async () => {
  const directory = mkdtempSync(join(tmpdir(), "boss-invitations-current-me-"));
  const ctx = setup(directory, { omitActiveBossBattle: true });
  try {
    const entry = await ctx.service.identify(token);
    await issue(ctx.service, entry, "accept-current-me", "invitations.accept", {
      invitationId: "invite-9",
    });
    assert.equal(ctx.service.snapshot(entry).battle.battle.id, "battle-9");
    const postIndex = ctx.calls.findIndex(
      (c) => c.method === "POST" && c.path.endsWith("/accept"),
    );
    assert.ok(postIndex > 0);
    assert.ok(
      ctx.calls
        .slice(0, postIndex)
        .some((c) => c.method === "GET" && c.path === "/api/bosses/7"),
    );
    assert.equal(ctx.pendingBeforePost.length, 1);
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("missing me active battle never treats an incomplete boss response as no fight", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "boss-invitations-incomplete-detail-"),
  );
  const ctx = setup(directory, {
    omitActiveBossBattle: true,
    omitBossActiveBattle: true,
  });
  try {
    const entry = await ctx.service.identify(token);
    await assert.rejects(
      issue(ctx.service, entry, "accept-incomplete", "invitations.accept", {
        invitationId: "invite-9",
      }),
      /active_battle_unknown/,
    );
    assert.equal(ctx.calls.filter((c) => c.method === "POST").length, 0);
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
