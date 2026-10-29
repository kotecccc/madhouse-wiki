import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isFinishedInvitation,
  projectBossInvitations,
  BOSS_INVITATIONS_PATH,
} from "../scripts/automation/boss-invitations.mjs";
import { createAutomationService } from "../scripts/automation/service.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";
import { actionQueueCards } from "../src/features/action-queue/action-queue-view.js";
import { inventoryGame } from "./helpers/inventory-game.mjs";

const token = "Bearer invitations.token.sig";
const now = 1_000_000;
const future = new Date(now + 60_000).toISOString();

test("only exact terminal invitation evidence can clear an uncertain join early", () => {
  const pending = { invitationId: "i", battleId: "b", bossId: 7 };
  const row = { ...pending, status: "expired", battleStatus: "won" };
  assert.equal(isFinishedInvitation({ items: [row] }, pending), true);
  assert.equal(
    isFinishedInvitation({ items: [row], partial: true }, pending),
    false,
  );
  assert.equal(
    isFinishedInvitation({ items: [row], error: "failure" }, pending),
    false,
  );
  for (const items of [
    [],
    [row, row],
    [{ ...row, battleId: "other" }],
    [{ ...row, bossId: 8 }],
    [{ ...row, status: "pending" }],
    [{ ...row, battleStatus: "active" }],
  ])
    assert.equal(isFinishedInvitation({ items }, pending), false);
  assert.equal(isFinishedInvitation({}, pending), false);
});

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
      battleExpiresAt: now + 60_000,
      available: true,
    },
  ]);
  assert.equal(JSON.stringify(projected).includes("secret"), false);
  await assert.rejects(
    projectBossInvitations({}, () => null, now),
    /invalid_boss_invitations/,
  );
});

test("keeps battle expiry separate from the shorter invitation expiry", async () => {
  const [item] = await projectBossInvitations(
    {
      items: [
        {
          invitationId: "invite",
          battleId: "battle",
          bossId: 7,
          status: "pending",
          battleStatus: "active",
          expiresAtUtc: future,
          battleExpiresAtUtc: new Date(now + 120_000).toISOString(),
        },
      ],
    },
    () => ({ name: "Boss" }),
    now,
  );
  assert.equal(item.expiresAt, now + 60_000);
  assert.equal(item.battleExpiresAt, now + 120_000);
});

test("leader identity is exposed only when inviter and peer identify the leader", async () => {
  const common = {
    bossId: 7,
    status: "pending",
    battleStatus: "active",
    expiresAtUtc: future,
    battleExpiresAtUtc: future,
    leaderPlayerId: 42,
    inviterPlayerId: 42,
    peerPlayerId: 42,
    peerNickname: "Лидер",
  };
  const projected = await projectBossInvitations(
    {
      items: [
        { ...common, invitationId: "one", battleId: "b1" },
        { ...common, invitationId: "two", battleId: "b2", peerPlayerId: 43 },
        {
          ...common,
          invitationId: "three",
          battleId: "b3",
          inviterPlayerId: null,
        },
      ],
    },
    () => ({ name: "Босс" }),
    now,
  );
  assert.equal(projected[0].leaderPlayerId, 42);
  assert.equal(projected[1].leaderPlayerId, undefined);
  assert.equal(projected[2].leaderPlayerId, undefined);
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
    if (
      url.pathname === "/api/clothing/by-category/1" ||
      url.pathname === "/api/weapons/repair" ||
      url.pathname === "/api/weapons/select"
    ) {
      if (options.weaponGame) return options.weaponGame.fetcher(input, init);
      if (method === "GET") return Response.json({ success: true, items: [] });
    }
    if (url.pathname === "/api/me")
      return Response.json({
        playerId: 101,
        nickname: "Alice",
        ...(options.me ?? {}),
        ...(options.omitActiveBossBattle
          ? {}
          : { activeBossBattle: ownActiveBattle }),
      });
    if (url.pathname === "/api/combat")
      return Response.json({ activeBattle: null });
    if (url.pathname === BOSS_INVITATIONS_PATH.split("?")[0])
      return Response.json({
        items:
          accepted && url.searchParams.has("limit") && options.history
            ? options.history
            : options.invitations
              ? await options.invitations()
              : accepted
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
      if (options.acceptGate) await options.acceptGate();
      if (options.timeoutPost) throw new Error("simulated timeout");
      if (options.rateLimitPost)
        return new Response(null, {
          status: 429,
          headers: { "Retry-After": "120" },
        });
      return new Response(null, { status: 204 });
    }
    if (
      url.pathname === "/api/bosses/battles/battle-9/attack" &&
      method === "POST"
    )
      return Response.json(invitationBattle());
    if (
      url.pathname === "/api/bosses/battles/battle-9" &&
      options.rateLimitBattleRead
    )
      return new Response(null, {
        status: 429,
        headers: { "Retry-After": "120" },
      });
    if (
      url.pathname === "/api/bosses/battles/battle-9" &&
      accepted &&
      options.battleUnavailableAfterAccept
    )
      return new Response(null, { status: 404 });
    if (url.pathname === "/api/bosses/battles/battle-9")
      return Response.json({
        ...invitationBattle(
          options.mismatchedBattle ? "other-battle" : "battle-9",
          options.foreignParticipant ? [{ playerId: 202 }] : undefined,
        ),
        ...(options.battleStatus
          ? { status: options.battleStatus(), reward: { drops: [] } }
          : {}),
      });
    if (options.extraRoute) {
      const response = await options.extraRoute(url.pathname, method, init);
      if (response) return response;
    }
    return Response.json({ error: "unexpected_fake_route" }, { status: 404 });
  };
  const service = createAutomationService({
    store,
    getBoss:
      options.getBoss ?? ((id) => ({ numericId: id, name: `Boss ${id}` })),
    ...(options.catalogue
      ? { getBusinessCatalogue: () => options.catalogue }
      : {}),
    fetcher,
    now: () => currentNow,
    ...(options.globalRaids
      ? {
          globalRaidsChatId: "-100123",
          telegram: { request: async () => ({ message_id: 1 }) },
        }
      : {}),
    random: () => 0,
    schedule: options.schedule ?? (() => ({ unref() {} })),
    cancel: options.cancel ?? (() => {}),
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

test("TMA and global raids share one invitation read without battle detail requests", async () => {
  const directory = mkdtempSync(join(tmpdir(), "shared-invitation-poll-"));
  const items = Array.from({ length: 6 }, (_, i) => ({
    invitationId: `shared-${i}`,
    battleId: `battle-${i}`,
    bossId: 7,
    leaderPlayerId: 42,
    inviterPlayerId: 42,
    peerPlayerId: 42,
    peerNickname: "Leader",
    status: "pending",
    battleStatus: "active",
    expiresAtUtc: future,
    battleExpiresAtUtc: future,
  }));
  const ctx = setup(directory, { globalRaids: true, invitations: () => items });
  try {
    const entry = await ctx.service.identify(token);
    await ctx.service.boot();
    await issue(ctx.service, entry, "shared-read-01", "invitations.refresh");
    assert.equal(
      ctx.calls.filter((c) => c.path === BOSS_INVITATIONS_PATH).length,
      1,
    );
    assert.equal(
      ctx.calls.filter((c) => /^\/api\/bosses\/battles\//.test(c.path)).length,
      0,
    );
    assert.equal(ctx.service.snapshot(entry).invitations.items.length, 6);
    assert.equal(ctx.store.readGlobalRaids().raids[0].count, 6);
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("global summary imports the saved TMA history on the shared invitation poll", async () => {
  const directory = mkdtempSync(join(tmpdir(), "global-existing-history-"));
  let ctx = setup(directory);
  try {
    await ctx.service.identify(token);
    const saved = ctx.store.read(101);
    saved.raidObservations = [
      {
        leaderPlayerId: 42,
        bossId: 7,
        battleId: "old-1",
        seenAt: now - 300_000,
      },
      {
        leaderPlayerId: 42,
        bossId: 7,
        battleId: "old-2",
        seenAt: now - 200_000,
      },
      {
        leaderPlayerId: 42,
        bossId: 7,
        battleId: "old-3",
        seenAt: now - 100_000,
      },
    ];
    ctx.store.write(101, saved);
    ctx.close();
    ctx = setup(directory, {
      globalRaids: true,
      invitations: () => [
        {
          invitationId: "active-invite",
          battleId: "old-3",
          bossId: 7,
          leaderPlayerId: 42,
          inviterPlayerId: 42,
          peerPlayerId: 42,
          peerNickname: "Leader",
          status: "pending",
          battleStatus: "active",
          expiresAtUtc: future,
          battleExpiresAtUtc: future,
        },
      ],
    });
    await ctx.service.boot();
    const entry = await ctx.service.identify(token);
    await issue(ctx.service, entry, "history-read-01", "invitations.refresh");
    const detected = ctx.service.snapshot(entry).detectedRaids;
    const rows = ctx.store.readGlobalRaids().raids;
    assert.equal(detected[0].count, 3);
    assert.equal(rows[0].count, 3);
    assert.equal(rows[0].active, true);
    assert.equal(
      ctx.calls.filter((c) => c.path === BOSS_INVITATIONS_PATH).length,
      1,
    );
    assert.equal(
      ctx.calls.filter((c) => /^\/api\/bosses\/battles\//.test(c.path)).length,
      0,
    );
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a slow shared invitation poll waits a full interval after completion", async () => {
  const directory = mkdtempSync(join(tmpdir(), "slow-shared-invitation-"));
  let release;
  let started;
  const begun = new Promise((resolve) => {
    started = resolve;
  });
  const ctx = setup(directory, {
    globalRaids: true,
    invitations: () =>
      new Promise((resolve) => {
        release = resolve;
        started();
      }),
  });
  try {
    await ctx.service.identify(token);
    await ctx.service.boot();
    await begun;
    ctx.setNow(now + 90_000);
    release([]);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(
      ctx.calls.filter((c) => c.path === BOSS_INVITATIONS_PATH).length,
      1,
    );
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function issue(service, entry, id, name, args = {}) {
  return service.command(entry, {
    id,
    command: name,
    expectedVersion: service.snapshot(entry).version,
    args,
  });
}

test("friend request checkpoint survives restart and is reconciled without replay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raid-friend-restart-"));
  let posted = 0;
  let accepted = false;
  const extraRoute = async (path, method) => {
    if (path === "/api/friends/search")
      return Response.json({
        player: { playerId: 42, username: "bob" },
        relationship: "none",
      });
    if (path === "/api/friends")
      return Response.json({
        items: accepted ? [{ player: { playerId: 42, username: "bob" } }] : [],
        nextCursor: null,
      });
    if (
      path === "/api/friends/requests/outgoing" ||
      path === "/api/friends/requests/incoming"
    )
      return Response.json({ items: [], nextCursor: null });
    if (path === "/api/friends/requests" && method === "POST") {
      posted++;
      throw new Error("lost reply");
    }
    return null;
  };
  let ctx = setup(directory, { extraRoute });
  try {
    let entry = await ctx.service.identify(token);
    await assert.rejects(
      issue(ctx.service, entry, "friend-request-01", "raid.friend.request", {
        username: "bob",
      }),
      /lost reply/,
    );
    assert.equal(ctx.store.read("101").raidFriend.pending.playerId, 42);
    ctx.close();
    ctx = setup(directory, { extraRoute });
    entry = await ctx.service.identify(token);
    await issue(ctx.service, entry, "friend-refresh-01", "raid.friend.refresh");
    assert.equal(ctx.service.snapshot(entry).raidFriend.status, "uncertain");
    accepted = true;
    await issue(ctx.service, entry, "friend-refresh-02", "raid.friend.refresh");
    assert.equal(ctx.service.snapshot(entry).raidFriend.status, "friend");
    assert.equal(posted, 1);
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

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

test("server discovers and persists invitations after restart without an open browser", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raid-discovery-restart-"));
  let ctx = setup(directory);
  try {
    await ctx.service.identify(token);
    ctx.close();
    ctx = setup(directory, {
      invitations: () => [
        {
          invitationId: "invite-discovery",
          battleId: "battle-discovery",
          bossId: 7,
          leaderPlayerId: 42,
          inviterPlayerId: 42,
          peerPlayerId: 42,
          status: "pending",
          battleStatus: "active",
          expiresAtUtc: future,
          battleExpiresAtUtc: future,
        },
      ],
    });
    await ctx.service.boot();
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.deepEqual(ctx.store.read("101").raidObservations, [
      {
        leaderPlayerId: 42,
        bossId: 7,
        battleId: "battle-discovery",
        seenAt: now,
      },
    ]);
    assert.equal(ctx.calls.filter((call) => call.method === "POST").length, 0);
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("page launch waits for background invitation discovery rather than failing with a conflict", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raid-discovery-launch-"));
  let release;
  let started;
  const discoveryStarted = new Promise((resolve) => {
    started = resolve;
  });
  const ctx = setup(directory, {
    invitations: () =>
      new Promise((resolve) => {
        release = () => resolve([]);
        started();
      }),
  });
  try {
    const entry = await ctx.service.identify(token);
    await ctx.service.boot();
    await discoveryStarted;
    let settled = false;
    const launch = ctx.service.launch(entry, null).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    release();
    const snapshot = await launch;
    assert.equal(snapshot.subscription.enabled, false);
    assert.equal(ctx.calls.filter((call) => call.method === "POST").length, 0);
  } finally {
    release?.();
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("observations survive failed reads and restart without counting a repeated battle", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raid-discovery-failure-"));
  let battle = "one";
  let unavailable = false;
  const invitations = () => {
    if (unavailable) throw new Error("temporary outage");
    return [
      {
        invitationId: `invite-${battle}`,
        battleId: battle,
        bossId: 7,
        leaderPlayerId: 42,
        inviterPlayerId: 42,
        peerPlayerId: 42,
        status: "pending",
        battleStatus: "active",
        expiresAtUtc: future,
        battleExpiresAtUtc: future,
      },
    ];
  };
  let ctx = setup(directory, { invitations });
  try {
    let entry = await ctx.service.identify(token);
    await issue(ctx.service, entry, "read-raid-01", "invitations.refresh");
    await issue(ctx.service, entry, "read-raid-02", "invitations.refresh");
    battle = "two";
    ctx.setNow(now + 11_000);
    await issue(ctx.service, entry, "read-raid-03", "invitations.refresh");
    unavailable = true;
    ctx.setNow(now + 22_000);
    await assert.rejects(
      issue(ctx.service, entry, "read-raid-04", "invitations.refresh"),
    );
    assert.equal(ctx.store.read("101").raidObservations.length, 2);
    ctx.close();
    unavailable = false;
    battle = "three";
    ctx = setup(directory, { invitations, now: now + 33_000 });
    entry = await ctx.service.identify(token);
    await issue(ctx.service, entry, "read-raid-05", "invitations.refresh");
    assert.equal(ctx.service.snapshot(entry).detectedRaids[0].count, 3);
    assert.equal(ctx.calls.filter((call) => call.method === "POST").length, 0);
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

test("terminal invitation clears an uncertain join only after confirming no active battle", async (t) => {
  for (const active of [false, true]) {
    await t.test(
      active
        ? "active battle keeps checkpoint"
        : "finished battle releases checkpoint",
      async () => {
        const directory = mkdtempSync(
          join(tmpdir(), "boss-invitations-terminal-"),
        );
        const ctx = setup(directory, {
          timeoutPost: true,
          battleUnavailableAfterAccept: true,
          omitActiveBossBattle: true,
          ...(active
            ? { detailActiveBattle: { battleId: "other", bossId: 7 } }
            : {}),
          history: [
            {
              invitationId: "invite-9",
              battleId: "battle-9",
              bossId: 7,
              status: "expired",
              battleStatus: "won",
            },
          ],
        });
        try {
          const entry = await ctx.service.identify(token);
          await assert.rejects(
            issue(
              ctx.service,
              entry,
              "terminal-accept-1",
              "invitations.accept",
              { invitationId: "invite-9" },
            ),
          );
          assert.ok(ctx.service.snapshot(entry).battle.pendingInvitation);
          await issue(
            ctx.service,
            entry,
            "terminal-refresh-1",
            "invitations.refresh",
          );
          assert.equal(
            ctx.service.snapshot(entry).battle.pendingInvitation === null,
            !active,
          );
          assert.ok(
            ctx.calls.some(
              (call) => call.path === "/api/bosses/invitations?limit=100",
            ),
          );
          assert.equal(
            ctx.calls.filter((call) => call.method === "POST").length,
            1,
          );
        } finally {
          ctx.close();
          rmSync(directory, { recursive: true, force: true });
        }
      },
    );
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

test("combat starts reconcile a pending inventory action without replaying the purchase", async (t) => {
  for (const command of ["auto.start", "raid.start"]) {
    await t.test(command, async () => {
      const directory = mkdtempSync(
        join(tmpdir(), "combat-inventory-reconcile-"),
      );
      const ctx = setup(directory, {
        extraRoute: (path, method) =>
          path === "/api/clothing" && method === "GET"
            ? Response.json({
                catalog: { sets: [{ items: [{ id: 220, owned: true }] }] },
              })
            : null,
      });
      try {
        const entry = await ctx.service.identify(token);
        await entry.controller.open({ numericId: 7, name: "Boss 7" });
        entry.equipment = {
          pending: {
            type: "clothing_item",
            entityId: 220,
            action: "buy",
            id: "old-buy",
          },
          checked: false,
        };
        const result = await issue(
          ctx.service,
          entry,
          `start-${command.replace(".", "-")}-test`,
          command,
          { settings: raidSettings },
        );
        assert.equal(result.equipment.pending, null);
        assert.ok(
          ctx.calls.some(
            (call) => call.method === "GET" && call.path === "/api/clothing",
          ),
        );
        assert.equal(
          ctx.calls.filter(
            (call) => call.method === "POST" && call.path.includes("/buy"),
          ).length,
          0,
        );
        assert.equal(
          command === "auto.start" ? result.auto.enabled : result.raid.enabled,
          true,
        );
      } finally {
        ctx.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

test("floor mode accepts an invitation using the durable raid checkpoint", async () => {
  const directory = mkdtempSync(join(tmpdir(), "floor-raid-service-"));
  const ctx = setup(directory, {
    omitActiveBossBattle: true,
    catalogue: {
      floors: [{ id: "a", code: "A" }],
      departments: [
        { id: "a1", floorId: "a", code: "A1" },
        { id: "a2", floorId: "a", code: "A2" },
      ],
      works: [],
      businesses: [],
      businessUpgrades: [],
      bosses: [{ id: "boss-7", apiId: "7", numericId: 7 }],
    },
    extraRoute: (path) => {
      if (path === "/api/floors")
        return Response.json([{ code: "A", isAvailable: true }]);
      if (path === "/api/floors/A/info")
        return Response.json({
          departments: [
            { blockCode: "A1", unlocked: true },
            {
              blockCode: "A2",
              unlocked: false,
              requirements: [
                { type: "boss_kills", bossId: 7, current: 0, required: 2 },
              ],
            },
          ],
        });
      return null;
    },
  });
  try {
    const entry = await ctx.service.identify(token);
    await issue(ctx.service, entry, "floor-start-raid", "floor.start");
    await entry.floorRunner.tick();
    assert.equal(ctx.service.snapshot(entry).floorRunner.phase, "executing");
    await entry.raidWorker.tick();
    const state = ctx.service.snapshot(entry);
    assert.equal(state.raid.status, "fighting");
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
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("raid repairs a broken weapon before joining and never joins after an uncertain repair", async (t) => {
  for (const failMutation of [false, true]) {
    await t.test(
      failMutation ? "lost repair reply" : "confirmed repair",
      async () => {
        const directory = mkdtempSync(join(tmpdir(), "raid-weapon-preflight-"));
        const weaponGame = inventoryGame({
          owned: true,
          equipped: true,
          broken: true,
          pills: 10000,
          cost: 30,
          failMutation,
        });
        const ctx = setup(directory, {
          omitActiveBossBattle: true,
          weaponGame,
        });
        try {
          const entry = await ctx.service.identify(token);
          await entry.controller.open({ numericId: 7, name: "Boss 7" });
          await issue(ctx.service, entry, "raid-weapon-start", "raid.start", {
            settings: raidSettings,
          });
          await entry.raidWorker.tick();
          assert.equal(weaponGame.mutations().length, 1);
          assert.equal(weaponGame.mutations()[0].path, "/api/weapons/repair");
          assert.equal(
            ctx.calls.filter(
              (call) => call.path.endsWith("/accept") && call.method === "POST",
            ).length,
            failMutation ? 0 : 1,
          );
          assert.equal(
            Boolean(ctx.store.read("101").equipment.pending),
            failMutation,
          );
          await entry.raidWorker.tick();
          assert.equal(weaponGame.mutations().length, 1);
        } finally {
          ctx.close();
          rmSync(directory, { recursive: true, force: true });
        }
      },
    );
  }
});

test("raid command persists waiting intent, accepts with checkpoint, and blocks competing actions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raid-service-"));
  let battleStatus = "active";
  const ctx = setup(directory, {
    omitActiveBossBattle: true,
    battleStatus: () => battleStatus,
  });
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
    assert.equal(ctx.service.snapshot(entry).raid.stopAfterBattle, true);
    assert.equal(ctx.service.snapshot(entry).auto.enabled, true);
    assert.equal(ctx.store.read("101").auto.singleBattle, true);
    assert.equal(ctx.store.read("101").auto.singleBattleId, "battle-9");
    assert.equal(ctx.service.snapshot(entry).goal.status, "active");
    battleStatus = "won";
    await entry.controller.refresh();
    await entry.raidWorker.tick();
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

test("raid stop during an already submitted join finishes the confirmed fight", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raid-stop-join-"));
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ctx = setup(directory, {
    omitActiveBossBattle: true,
    acceptGate: () => gate,
  });
  try {
    const entry = await ctx.service.identify(token);
    await entry.controller.open({ numericId: 7, name: "Boss 7" });
    await issue(ctx.service, entry, "start-stop-join", "raid.start", {
      settings: raidSettings,
    });
    const joining = entry.raidWorker.tick();
    for (let i = 0; i < 30 && ctx.pendingBeforePost.length === 0; i++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ctx.pendingBeforePost.length, 1);
    await issue(ctx.service, entry, "stop-during-join", "raid.stop");
    release();
    await joining;
    await entry.raidWorker.tick();
    const state = ctx.service.snapshot(entry);
    assert.equal(state.raid.stopAfterBattle, true);
    assert.equal(state.battle.battle?.status, "active");
    assert.equal(state.auto.enabled, true);
    assert.equal(ctx.pendingBeforePost.length, 1);
  } finally {
    release();
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("raid stop-after-fight survives a restart without reopening the series", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raid-finish-restart-"));
  let ctx = setup(directory, { omitActiveBossBattle: true });
  try {
    let entry = await ctx.service.identify(token);
    await entry.controller.open({ numericId: 7, name: "Boss 7" });
    await issue(ctx.service, entry, "start-raid-finish", "raid.start", {
      settings: raidSettings,
    });
    await entry.raidWorker.tick();
    await issue(ctx.service, entry, "stop-raid-finish", "raid.stop");
    ctx.close();
    ctx = setup(directory, {
      activeBattle: { battleId: "battle-9", bossId: 7 },
    });
    await ctx.service.boot();
    entry = await ctx.service.identify(token);
    const state = ctx.service.snapshot(entry);
    assert.equal(state.raid.stopAfterBattle, true);
    assert.equal(state.auto.enabled, true);
    assert.equal(ctx.store.read("101").auto.singleBattleId, "battle-9");
    assert.equal(ctx.calls.filter((call) => call.method === "POST").length, 0);
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

test("subscription persists and suspends an existing raid before an uncertain join", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "subscription-service-restart-"),
  );
  const invitations = () => [
    {
      invitationId: "invite-9",
      battleId: "battle-9",
      bossId: 7,
      leaderPlayerId: 42,
      inviterPlayerId: 42,
      peerPlayerId: 42,
      status: "pending",
      battleStatus: "active",
      expiresAtUtc: future,
      battleExpiresAtUtc: future,
      peerNickname: "Bob",
    },
  ];
  let ctx = setup(directory, { timeoutPost: true, invitations });
  try {
    let entry = await ctx.service.identify(token);
    await entry.controller.open({ numericId: 7, name: "Boss 7" });
    await issue(ctx.service, entry, "subscribe-setup-raid", "raid.start", {
      settings: raidSettings,
    });
    await issue(
      ctx.service,
      entry,
      "subscribe-refresh-1",
      "invitations.refresh",
    );
    await issue(
      ctx.service,
      entry,
      "subscribe-start-01",
      "subscription.start",
      { leaderPlayerId: 42, bossId: 7 },
    );
    await entry.raidSubscription.tick();
    const saved = ctx.store.read("101");
    assert.equal(saved.raidSubscription.phase, "confirming");
    assert.equal(saved.raidSubscription.checkpoint.raidEnabled, true);
    assert.equal(saved.raidSubscription.checkpoint.goal.settings.bossId, 7);
    assert.ok(saved.battle.pendingInvitation);
    assert.equal(
      ctx.calls.filter(
        (call) => call.method === "POST" && call.path.endsWith("/accept"),
      ).length,
      1,
    );
    ctx.close();
    ctx = setup(directory, {
      invitations,
      extraRoute: (path, method) =>
        path === "/api/clothing/by-category/1" && method === "GET"
          ? Response.json({ items: [] })
          : null,
    });
    await ctx.service.boot();
    entry = await ctx.service.identify(token);
    await entry.raidSubscription.tick();
    assert.equal(ctx.service.snapshot(entry).subscription.phase, "fighting");
    assert.equal(ctx.calls.filter((call) => call.method === "POST").length, 0);
    await issue(ctx.service, entry, "subscribe-stop-prior", "raid.stop");
    assert.equal(
      ctx.store.read("101").raidSubscription.checkpoint.raidEnabled,
      false,
    );
    assert.equal(ctx.service.snapshot(entry).raid.enabled, false);
    assert.equal(ctx.service.snapshot(entry).subscription.phase, "fighting");
    await assert.rejects(
      issue(ctx.service, entry, "inventory-buy-01", "inventory.action", {
        type: "weapon",
        id: 1,
        action: "buy",
        price: { currency: "gold", amount: 100 },
      }),
      /subscription_controls_automation/,
    );
    await issue(ctx.service, entry, "inventory-check-01", "inventory.refresh", {
      type: "weapon",
    });
    assert.ok(
      ctx.calls.some(
        (call) =>
          call.path === "/api/clothing/by-category/1" && call.method === "GET",
      ),
    );
    assert.equal(ctx.calls.filter((call) => call.method === "POST").length, 0);
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("subscription refuses an unverified leader without a game mutation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "subscription-identity-"));
  const ctx = setup(directory, {
    invitations: () => [
      {
        invitationId: "invite-9",
        battleId: "battle-9",
        bossId: 7,
        leaderPlayerId: 42,
        inviterPlayerId: 42,
        peerPlayerId: 42,
        status: "pending",
        battleStatus: "active",
        expiresAtUtc: future,
        battleExpiresAtUtc: future,
      },
    ],
  });
  try {
    const entry = await ctx.service.identify(token);
    await assert.rejects(
      issue(ctx.service, entry, "subscribe-invalid-1", "subscription.start", {
        leaderPlayerId: 43,
        bossId: 7,
      }),
      /subscription_leader_unverified/,
    );
    assert.equal(ctx.service.snapshot(entry).subscription.enabled, false);
    assert.equal(ctx.calls.filter((call) => call.method === "POST").length, 0);
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a scheduled raid can wait for a verified invitation without sending a game mutation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "subscription-scheduled-"));
  const ctx = setup(directory, { invitations: () => [] });
  try {
    const entry = await ctx.service.identify(token);
    await issue(
      ctx.service,
      entry,
      "scheduled-subscribe",
      "subscription.start",
      { leaderUsername: "@alice", bossId: 7 },
    );
    await entry.raidSubscription.tick();
    const saved = ctx.store.read("101").raidSubscription;
    assert.equal(saved.leaderPlayerId, null);
    assert.equal(saved.phase, "monitoring");
    assert.equal(saved.leaderUsername, "@alice");
    assert.equal(ctx.calls.filter((call) => call.method === "POST").length, 0);
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restart during suspension reconciles the old battle before pausing the prior raid", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "subscription-suspend-restart-"),
  );
  const invitations = () => [
    {
      invitationId: "invite-9",
      battleId: "battle-9",
      bossId: 7,
      leaderPlayerId: 42,
      inviterPlayerId: 42,
      peerPlayerId: 42,
      status: "pending",
      battleStatus: "active",
      expiresAtUtc: future,
      battleExpiresAtUtc: future,
    },
  ];
  let ctx = setup(directory, { invitations });
  try {
    let entry = await ctx.service.identify(token);
    await entry.controller.open({ numericId: 7, name: "Boss 7" });
    await issue(ctx.service, entry, "restart-raid-01", "raid.start", {
      settings: raidSettings,
    });
    await issue(
      ctx.service,
      entry,
      "restart-subscription-01",
      "subscription.start",
      { leaderPlayerId: 42, bossId: 7 },
    );
    const saved = ctx.store.read("101");
    saved.raidSubscription.phase = "suspending";
    saved.raidSubscription.checkpoint = {
      bossId: 7,
      goal: saved.goalRecord,
      auto: saved.auto,
      raidEnabled: true,
      businessRunning: false,
      workRunning: false,
    };
    ctx.store.write("101", saved);
    ctx.close();
    ctx = setup(directory, { invitations });
    await ctx.service.boot();
    entry = await ctx.service.identify(token);
    await entry.raidSubscription.tick();
    assert.equal(ctx.service.snapshot(entry).subscription.phase, "waiting");
    assert.equal(
      ctx.store.read("101").raidSubscription.checkpoint.raidEnabled,
      true,
    );
    assert.equal(ctx.calls.filter((call) => call.method === "POST").length, 0);
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("after a subscribed battle and a quiet interval the saved raid goal resumes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "subscription-resume-raid-"));
  let status = "active";
  let invited = true;
  const invitations = () =>
    invited
      ? [
          {
            invitationId: "invite-9",
            battleId: "battle-9",
            bossId: 7,
            leaderPlayerId: 42,
            inviterPlayerId: 42,
            peerPlayerId: 42,
            status: "pending",
            battleStatus: "active",
            expiresAtUtc: future,
            battleExpiresAtUtc: future,
          },
        ]
      : [];
  const ctx = setup(directory, { invitations, battleStatus: () => status });
  try {
    const entry = await ctx.service.identify(token);
    await entry.controller.open({ numericId: 7, name: "Boss 7" });
    await issue(ctx.service, entry, "resume-raid-setup", "raid.start", {
      settings: raidSettings,
    });
    const originalGoal = structuredClone(entry.goal.exportState());
    await issue(ctx.service, entry, "resume-sub-start", "subscription.start", {
      leaderPlayerId: 42,
      bossId: 7,
    });
    await entry.raidSubscription.tick();
    assert.equal(ctx.service.snapshot(entry).subscription.phase, "fighting");
    status = "won";
    invited = false;
    await entry.controller.refresh();
    await entry.raidSubscription.tick();
    assert.equal(ctx.service.snapshot(entry).subscription.phase, "waiting");
    ctx.setNow(now + 601_000);
    await issue(ctx.service, entry, "resume-read-fresh", "invitations.refresh");
    await entry.raidSubscription.tick();
    assert.equal(ctx.service.snapshot(entry).subscription.phase, "monitoring");
    assert.equal(ctx.service.snapshot(entry).raid.enabled, true);
    assert.deepEqual(entry.goal.exportState(), originalGoal);
    assert.equal(
      ctx.calls.filter(
        (call) => call.method === "POST" && call.path.endsWith("/accept"),
      ).length,
      1,
    );
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a queued autobattle suspended by a subscription keeps its identity after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "subscription-queued-auto-"));
  const options = {
    invitations: () => [
      {
        invitationId: "invite-9",
        battleId: "battle-9",
        bossId: 7,
        leaderPlayerId: 42,
        inviterPlayerId: 42,
        peerPlayerId: 42,
        status: "pending",
        battleStatus: "active",
        expiresAtUtc: future,
        battleExpiresAtUtc: future,
      },
    ],
  };
  let ctx = setup(directory, options);
  try {
    let entry = await ctx.service.identify(token);
    await entry.controller.open({ numericId: 7, name: "Boss 7" });
    await ctx.service.boot();
    await issue(ctx.service, entry, "queued-auto", "queue.enqueue", {
      type: "auto.start",
      action: { settings: raidSettings },
    });
    const end = Date.now() + 4000;
    while (Date.now() < end && !ctx.service.snapshot(entry).auto.enabled)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(ctx.service.snapshot(entry).auto.queueId, "queued-auto");
    ctx.setNow(now + 5000);
    await issue(
      ctx.service,
      entry,
      "subscribe-queued-auto",
      "subscription.start",
      {
        leaderPlayerId: 42,
        bossId: 7,
      },
    );
    await entry.raidSubscription.tick();
    await entry.raidSubscription.tick();
    assert.equal(ctx.service.snapshot(entry).subscription.suspendedAuto, true);
    assert.equal(
      ctx.store.read("101").raidSubscription.checkpoint.auto.queueId,
      "queued-auto",
    );
    ctx.close();
    ctx = setup(directory, { ...options, now: now + 10000 });
    const saved = ctx.store.read("101");
    for (let i = 0; i < 130; i++)
      saved.queuedActions.push({
        id: `older-completed-${i}`,
        type: "friend.favorite",
        args: { playerId: i + 1, enabled: false },
        status: "completed",
        priority: 30,
        createdAt: now + i,
        finishedAt: now + i,
      });
    ctx.store.write("101", saved);
    await ctx.service.boot();
    entry = await ctx.service.identify(token);
    const view = ctx.service.snapshot(entry);
    assert.equal(view.subscription.suspendedAuto, true);
    assert.equal(view.auto.queueId, "queued-auto");
    assert.ok(
      !actionQueueCards(view).some((card) => card.id === "queued-auto"),
    );
    await issue(ctx.service, entry, "trigger-history-prune", "queue.enqueue", {
      type: "friend.favorite",
      action: { playerId: 999, enabled: false },
    });
    assert.ok(
      ctx.store
        .read("101")
        .queuedActions.some((job) => job.id === "queued-auto"),
    );
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a suspended autobattle can be stopped without interrupting the subscribed fight", async () => {
  const directory = mkdtempSync(join(tmpdir(), "subscription-stop-auto-"));
  const ctx = setup(directory, {
    invitations: () => [
      {
        invitationId: "invite-9",
        battleId: "battle-9",
        bossId: 7,
        leaderPlayerId: 42,
        inviterPlayerId: 42,
        peerPlayerId: 42,
        status: "pending",
        battleStatus: "active",
        expiresAtUtc: future,
        battleExpiresAtUtc: future,
      },
    ],
  });
  try {
    const entry = await ctx.service.identify(token);
    await entry.controller.open({ numericId: 7, name: "Boss 7" });
    await issue(ctx.service, entry, "prior-auto-start", "auto.start", {
      settings: raidSettings,
    });
    await issue(ctx.service, entry, "auto-subscribe", "subscription.start", {
      leaderPlayerId: 42,
      bossId: 7,
    });
    await entry.raidSubscription.tick();
    await entry.raidSubscription.tick();
    assert.equal(ctx.service.snapshot(entry).subscription.suspendedAuto, true);
    assert.equal(entry.auto.getSnapshot().enabled, true);
    await issue(ctx.service, entry, "stop-prior-auto", "auto.stop");
    const saved = ctx.store.read("101").raidSubscription.checkpoint;
    assert.equal(saved.auto, null);
    assert.equal(saved.goal, null);
    assert.equal(entry.auto.getSnapshot().enabled, true);
    assert.equal(ctx.service.snapshot(entry).subscription.phase, "fighting");
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a suspended standalone boss goal can be stopped without interrupting the subscribed fight", async () => {
  const directory = mkdtempSync(join(tmpdir(), "subscription-stop-goal-"));
  const ctx = setup(directory, {
    invitations: () => [
      {
        invitationId: "invite-9",
        battleId: "battle-9",
        bossId: 7,
        leaderPlayerId: 42,
        inviterPlayerId: 42,
        peerPlayerId: 42,
        status: "pending",
        battleStatus: "active",
        expiresAtUtc: future,
        battleExpiresAtUtc: future,
      },
    ],
  });
  try {
    const entry = await ctx.service.identify(token);
    await entry.controller.open({ numericId: 7, name: "Boss 7" });
    await issue(
      ctx.service,
      entry,
      "prior-goal-configure",
      "goal.configure",
      raidSettings,
    );
    await issue(ctx.service, entry, "goal-subscribe", "subscription.start", {
      leaderPlayerId: 42,
      bossId: 7,
    });
    await entry.raidSubscription.tick();
    await entry.raidSubscription.tick();
    assert.equal(
      ctx.service.snapshot(entry).subscription.suspendedStandaloneGoal,
      true,
    );
    assert.equal(entry.auto.getSnapshot().enabled, true);
    await issue(ctx.service, entry, "stop-prior-goal", "goal.stop");
    assert.equal(ctx.store.read("101").raidSubscription.checkpoint.goal, null);
    assert.equal(entry.auto.getSnapshot().enabled, true);
    assert.equal(ctx.service.snapshot(entry).subscription.phase, "fighting");
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const mode of ["raid", "auto"])
  test(`a previously paused ${mode} can be stopped without interrupting a subscribed fight`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "subscription-stop-paused-"));
    const ctx = setup(directory, {
      invitations: () => [
        {
          invitationId: "invite-9",
          battleId: "battle-9",
          bossId: 7,
          leaderPlayerId: 42,
          inviterPlayerId: 42,
          peerPlayerId: 42,
          status: "pending",
          battleStatus: "active",
          expiresAtUtc: future,
          battleExpiresAtUtc: future,
        },
      ],
    });
    try {
      const entry = await ctx.service.identify(token);
      await entry.controller.open({ numericId: 7, name: "Boss 7" });
      await issue(ctx.service, entry, `paused-${mode}-start`, `${mode}.start`, {
        settings: raidSettings,
      });
      await issue(ctx.service, entry, `paused-${mode}-pause`, `${mode}.pause`);
      await issue(
        ctx.service,
        entry,
        `paused-${mode}-subscription`,
        "subscription.start",
        { leaderPlayerId: 42, bossId: 7 },
      );
      await entry.raidSubscription.tick();
      await entry.raidSubscription.tick();
      assert.equal(entry.auto.getSnapshot().enabled, true);
      await issue(ctx.service, entry, `paused-${mode}-stop`, `${mode}.stop`);
      assert.equal(entry.auto.getSnapshot().enabled, true);
      assert.equal(ctx.service.snapshot(entry).subscription.phase, "fighting");
      if (mode === "raid")
        assert.equal(ctx.service.snapshot(entry).raid.userPaused, false);
      else assert.equal(ctx.service.snapshot(entry).auto.userPaused, false);
    } finally {
      ctx.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

for (const stopWork of [false, true])
  test(`a subscribed raid safely ${stopWork ? "stops" : "resumes"} a work goal`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "subscription-resume-work-"));
    let status = "active",
      invited = true,
      progress = 0;
    const timers = [];
    const energy = {
      current: 10,
      max: 10,
      regenIntervalSeconds: 60,
      secondsToNext: 0,
    };
    const workState = () => ({
      workId: 7,
      title: "Work",
      completedCycles: 0,
      tasks: [
        {
          id: 1,
          title: "Task",
          required: 3,
          progress,
          energyCost: 1,
          canPerform: true,
        },
      ],
      energy,
    });
    const ctx = setup(directory, {
      me: { energy, wallet: { dollar: 100 } },
      catalogue: {
        businesses: [],
        businessUpgrades: [],
        bosses: [],
        works: [{ workId: 7, title: "Work" }],
      },
      battleStatus: () => status,
      invitations: () =>
        invited
          ? [
              {
                invitationId: "invite-9",
                battleId: "battle-9",
                bossId: 7,
                leaderPlayerId: 42,
                inviterPlayerId: 42,
                peerPlayerId: 42,
                status: "pending",
                battleStatus: "active",
                expiresAtUtc: future,
                battleExpiresAtUtc: future,
              },
            ]
          : [],
      schedule: (callback, delay) => {
        const timer = { callback, delay, canceled: false };
        timers.push(timer);
        return timer;
      },
      cancel: (timer) => {
        timer.canceled = true;
      },
      extraRoute: async (path) => {
        if (path === "/api/works/open") return Response.json(workState());
        if (path === "/api/me/bag") return Response.json({ boosters: {} });
        if (path === "/api/works/tasks/perform") {
          progress++;
          return Response.json(workState());
        }
        return null;
      },
    });
    try {
      const entry = await ctx.service.identify(token);
      await issue(ctx.service, entry, "work-priority-start", "work.start", {
        workId: 7,
        targetCycles: 1,
        maxActions: 10,
        durationHours: null,
        mode: "wait",
        maxBoosters: 0,
        allowPurchase: false,
        maxDollar: 0,
      });
      const before = structuredClone(ctx.service.snapshot(entry).workFarm.run);
      await issue(
        ctx.service,
        entry,
        "work-subscribe-start",
        "subscription.start",
        { leaderPlayerId: 42, bossId: 7 },
      );
      await entry.raidSubscription.tick();
      assert.equal(
        ctx.store.read("101").raidSubscription.checkpoint.workRunning,
        true,
      );
      assert.equal(timers.filter((timer) => !timer.canceled).length, 0);
      if (stopWork) {
        await issue(ctx.service, entry, "stop-suspended-work", "work.stop");
        assert.equal(
          ctx.store.read("101").raidSubscription.checkpoint.workRunning,
          false,
        );
        assert.equal(
          ctx.service.snapshot(entry).workFarm.run.status,
          "stopped",
        );
        assert.equal(
          ctx.service.snapshot(entry).subscription.phase,
          "fighting",
        );
      }
      status = "won";
      invited = false;
      await entry.controller.refresh();
      await entry.raidSubscription.tick();
      ctx.setNow(now + 601_000);
      await issue(
        ctx.service,
        entry,
        "work-subscribe-read",
        "invitations.refresh",
      );
      await entry.raidSubscription.tick();
      const resumed = ctx.service.snapshot(entry).workFarm.run;
      assert.equal(resumed.status, stopWork ? "stopped" : "running");
      assert.deepEqual(resumed.config, before.config);
      assert.equal(resumed.actionsDone, 0);
      if (stopWork) {
        assert.equal(progress, 0);
        assert.equal(
          ctx.calls.filter((call) => call.path === "/api/works/tasks/perform")
            .length,
          0,
        );
        return;
      }
      const timer = timers.find((item) => !item.canceled);
      assert.ok(timer);
      timer.canceled = true;
      timer.callback();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(progress, 1);
      assert.equal(
        ctx.calls.filter((call) => call.path === "/api/works/tasks/perform")
          .length,
        1,
      );
    } finally {
      ctx.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

for (const stopBusiness of [false, true, "paused"])
  test(`a subscribed raid safely ${stopBusiness ? "stops" : "resumes"} a business goal`, async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "subscription-resume-business-"),
    );
    let status = "active",
      invited = true;
    const timers = [];
    const catalogue = {
      businesses: [
        { id: "business:7", apiId: "7", title: "Workshop", maxLevel: 2 },
      ],
      businessUpgrades: [
        {
          businessId: "business:7",
          items: [{ entityId: 55, name: "Item", levels: [1, 1] }],
        },
      ],
      bosses: [
        {
          numericId: 7,
          name: "Boss 7",
          possibleDrops: [
            { type: "activity_item", entityId: 55, name: "Item" },
          ],
        },
      ],
    };
    const ctx = setup(directory, {
      catalogue,
      getBoss: (id) => catalogue.bosses.find((boss) => boss.numericId === id),
      battleStatus: () => status,
      invitations: () =>
        invited
          ? [
              {
                invitationId: "invite-9",
                battleId: "battle-9",
                bossId: 7,
                leaderPlayerId: 42,
                inviterPlayerId: 42,
                peerPlayerId: 42,
                status: "pending",
                battleStatus: "active",
                expiresAtUtc: future,
                battleExpiresAtUtc: future,
              },
            ]
          : [],
      schedule: (callback, delay) => {
        const timer = { callback, delay, canceled: false };
        timers.push(timer);
        return timer;
      },
      cancel: (timer) => {
        timer.canceled = true;
      },
      extraRoute: async (path) => {
        if (path === "/api/me/bag") return Response.json({ activityItems: [] });
        if (path === "/api/businesses/7")
          return Response.json({
            id: 7,
            level: 1,
            maxLevel: 2,
            nextUpgradePrice: 100,
            nextUpgradeCurrency: "gold",
          });
        return null;
      },
    });
    try {
      const entry = await ctx.service.identify(token);
      await issue(ctx.service, entry, "business-select-01", "business.select", {
        businessId: "business:7",
      });
      await issue(ctx.service, entry, "business-save-001", "business.save", {
        businessId: "business:7",
        targetLevel: 2,
        maxAttempts: 5,
        durationHours: null,
      });
      await issue(ctx.service, entry, "business-read-001", "business.refresh", {
        businessId: "business:7",
      });
      const plan = ctx.service.snapshot(entry).businessAssistant.plans[0];
      await issue(
        ctx.service,
        entry,
        "business-start-01",
        "business.run.start",
        {
          businessId: "business:7",
          expectedPlan: plan.config,
          expectedMissing: plan.materials.map((item) => ({
            itemId: item.entityId,
            amount: item.missingAmount,
          })),
        },
      );
      const before = structuredClone(
        ctx.service.snapshot(entry).businessAssistant.run,
      );
      if (stopBusiness === "paused")
        await issue(
          ctx.service,
          entry,
          "pause-before-subscription",
          "business.run.pause",
        );
      await issue(
        ctx.service,
        entry,
        "business-sub-start",
        "subscription.start",
        { leaderPlayerId: 42, bossId: 7 },
      );
      await entry.raidSubscription.tick();
      assert.equal(
        ctx.store.read("101").raidSubscription.checkpoint.businessRunning,
        stopBusiness !== "paused",
      );
      if (stopBusiness === "paused")
        assert.equal(
          ctx.store.read("101").raidSubscription.checkpoint.businessPaused,
          true,
        );
      assert.equal(timers.filter((timer) => !timer.canceled).length, 0);
      if (stopBusiness) {
        if (stopBusiness === "paused") {
          await entry.raidSubscription.tick();
          assert.equal(entry.auto.getSnapshot().enabled, true);
        }
        await issue(
          ctx.service,
          entry,
          "stop-suspended-business",
          "business.run.stop",
        );
        assert.equal(
          ctx.store.read("101").raidSubscription.checkpoint.businessRunning,
          false,
        );
        assert.equal(
          ctx.service.snapshot(entry).businessAssistant.run.status,
          "stopped",
        );
        assert.equal(
          ctx.service.snapshot(entry).subscription.phase,
          "fighting",
        );
        if (stopBusiness === "paused")
          assert.equal(entry.auto.getSnapshot().enabled, true);
      }
      status = "won";
      invited = false;
      await entry.controller.refresh();
      await entry.raidSubscription.tick();
      ctx.setNow(now + 601_000);
      await issue(
        ctx.service,
        entry,
        "business-sub-read",
        "invitations.refresh",
      );
      await entry.raidSubscription.tick();
      const resumed = ctx.service.snapshot(entry).businessAssistant.run;
      assert.equal(resumed.status, stopBusiness ? "stopped" : "running");
      assert.equal(resumed.battlesStarted, before.battlesStarted);
      assert.equal(resumed.maxBattles, before.maxBattles);
      assert.equal(
        ctx.service.snapshot(entry).subscription.phase,
        "monitoring",
      );
      if (stopBusiness) {
        assert.equal(timers.filter((timer) => !timer.canceled).length, 0);
        assert.equal(ctx.service.snapshot(entry).auto.enabled, false);
        return;
      }
      const timer = timers.find((item) => !item.canceled);
      assert.ok(timer);
      timer.canceled = true;
      timer.callback();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        ctx.service.snapshot(entry).businessAssistant.run.phase,
        "farming",
      );
      assert.equal(entry.auto.getSnapshot().enabled, true);
    } finally {
      ctx.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

test("restart applies a durable stop to a suspended work goal", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "subscription-stop-work-crash-"),
  );
  let ctx = setup(directory, { invitations: () => [] });
  try {
    let entry = await ctx.service.identify(token);
    await issue(ctx.service, entry, "work-before-crash", "work.start", {
      workId: 7,
      targetCycles: 1,
      maxActions: 10,
      durationHours: null,
      mode: "wait",
      maxBoosters: 0,
      allowPurchase: false,
      maxDollar: 0,
    });
    const saved = ctx.store.read("101");
    saved.raidSubscription = {
      enabled: true,
      mode: "subscription",
      phase: "waiting",
      leaderPlayerId: 42,
      bossId: 7,
      checkpoint: { workRunning: false, workCancelled: true },
    };
    ctx.store.write("101", saved);
    ctx.close();
    ctx = setup(directory, { invitations: () => [] });
    entry = await ctx.service.identify(token);
    assert.equal(ctx.service.snapshot(entry).workFarm.run.status, "stopped");
    assert.equal(ctx.store.read("101").workFarm.run.status, "stopped");
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const paused of [false, true])
  test(`restart applies a durable stop to a ${paused ? "paused" : "running"} suspended business goal`, async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "subscription-stop-business-crash-"),
    );
    let ctx = setup(directory, { invitations: () => [] });
    try {
      await ctx.service.identify(token);
      const saved = ctx.store.read("101");
      saved.businessHelper.run = {
        status: paused ? "paused" : "running",
        phase: "farming",
        pendingUpgrade: null,
      };
      saved.raidSubscription = {
        enabled: true,
        mode: "subscription",
        phase: "waiting",
        leaderPlayerId: 42,
        bossId: 7,
        checkpoint: { businessRunning: false, businessCancelled: true },
      };
      ctx.store.write("101", saved);
      ctx.close();
      ctx = setup(directory, { invitations: () => [] });
      await ctx.service.identify(token);
      assert.equal(ctx.store.read("101").businessHelper.run.status, "stopped");
    } finally {
      ctx.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

test("restart clears a paused autobattle after a durable stop", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "subscription-stop-auto-crash-"),
  );
  let ctx = setup(directory, { invitations: () => [] });
  try {
    let entry = await ctx.service.identify(token);
    await entry.controller.open({ numericId: 7, name: "Boss 7" });
    await issue(ctx.service, entry, "auto-before-crash", "auto.start", {
      settings: raidSettings,
    });
    await issue(ctx.service, entry, "auto-pause-before-crash", "auto.pause");
    const saved = ctx.store.read("101");
    assert.ok(saved.pausedAuto);
    saved.raidSubscription = {
      enabled: true,
      mode: "subscription",
      phase: "waiting",
      leaderPlayerId: 42,
      bossId: 7,
      checkpoint: { auto: null, autoCancelled: true },
    };
    ctx.store.write("101", saved);
    ctx.close();
    ctx = setup(directory, { invitations: () => [] });
    entry = await ctx.service.identify(token);
    assert.equal(ctx.service.snapshot(entry).auto.userPaused, false);
    assert.equal(ctx.store.read("101").pausedAuto, null);
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const paused of [false, true])
  test(`restart applies a durable stop to a ${paused ? "paused" : "running"} suspended raid goal`, async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "subscription-stop-raid-crash-"),
    );
    let ctx = setup(directory, { invitations: () => [] });
    try {
      let entry = await ctx.service.identify(token);
      await entry.controller.open({ numericId: 7, name: "Boss 7" });
      await issue(ctx.service, entry, "raid-before-crash", "raid.start", {
        settings: raidSettings,
      });
      if (paused)
        await issue(
          ctx.service,
          entry,
          "raid-pause-before-crash",
          "raid.pause",
        );
      const saved = ctx.store.read("101");
      saved.raidSubscription = {
        enabled: true,
        mode: "subscription",
        phase: "waiting",
        leaderPlayerId: 42,
        bossId: 7,
        checkpoint: { raidEnabled: false, raidCancelled: true },
      };
      ctx.store.write("101", saved);
      ctx.close();
      ctx = setup(directory, { invitations: () => [] });
      entry = await ctx.service.identify(token);
      assert.equal(ctx.service.snapshot(entry).raid.enabled, false);
      assert.equal(ctx.service.snapshot(entry).raid.userPaused, false);
      assert.equal(ctx.store.read("101").raid.enabled, false);
    } finally {
      ctx.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

test("stopping a suspended business during restoration cannot revive its old goal", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "subscription-stop-business-race-"),
  );
  let holdBoss = false;
  let releaseBoss;
  const options = {
    invitations: () => [],
    getBoss: (id) =>
      holdBoss
        ? new Promise((resolve) => {
            releaseBoss = () => resolve({ numericId: id, name: "Boss" });
          })
        : { numericId: id, name: "Boss" },
  };
  let ctx = setup(directory, options);
  try {
    await ctx.service.identify(token);
    const saved = ctx.store.read("101");
    saved.businessHelper.run = {
      status: "running",
      phase: "farming",
      pendingUpgrade: null,
      ownsGoal: true,
    };
    saved.raidSubscription = {
      enabled: false,
      mode: "subscription",
      phase: "restoring",
      leaderPlayerId: 42,
      bossId: 7,
      checkpoint: {
        bossId: 7,
        goal: { status: "active" },
        auto: { enabled: true },
        businessRunning: true,
        raidEnabled: false,
      },
    };
    ctx.store.write("101", saved);
    ctx.close();
    ctx = setup(directory, options);
    const entry = await ctx.service.identify(token);
    holdBoss = true;
    const restoring = entry.raidSubscription.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof releaseBoss, "function");
    await issue(
      ctx.service,
      entry,
      "stop-business-restoring",
      "business.run.stop",
    );
    releaseBoss();
    await restoring;
    const checkpoint = ctx.store.read("101").raidSubscription.checkpoint;
    assert.equal(checkpoint.businessRunning, false);
    assert.equal(checkpoint.goal, null);
    assert.equal(ctx.store.read("101").businessHelper.run.status, "stopped");
    assert.equal(ctx.service.snapshot(entry).auto.enabled, false);
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

test("Buddy inviter identity is retained only when peer identity agrees", async () => {
  const base = {
    bossId: 7,
    status: "pending",
    battleStatus: "active",
    expiresAtUtc: future,
    battleExpiresAtUtc: future,
    leaderPlayerId: 9,
    inviterPlayerId: 42,
  };
  const rows = await projectBossInvitations(
    {
      items: [
        { ...base, invitationId: "good", battleId: "a", peerPlayerId: 42 },
        { ...base, invitationId: "bad", battleId: "b", peerPlayerId: 9 },
        { ...base, invitationId: "unknown", battleId: "c" },
      ],
    },
    () => ({ name: "Босс" }),
    now,
  );
  assert.equal(rows[0].inviterPlayerId, 42);
  assert.equal(rows[0].leaderPlayerId, undefined);
  assert.equal(rows[1].inviterPlayerId, undefined);
  assert.equal(rows[2].inviterPlayerId, undefined);
});

test("Buddy follows a verified friend who is not the leader and survives restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "buddy-invitation-"));
  const invitations = () => [
    {
      invitationId: "invite-9",
      battleId: "battle-9",
      bossId: 7,
      leaderPlayerId: 9,
      inviterPlayerId: 42,
      peerPlayerId: 42,
      status: "pending",
      battleStatus: "active",
      expiresAtUtc: future,
      battleExpiresAtUtc: future,
    },
  ];
  const options = {
    invitations,
    extraRoute: (path) =>
      path === "/api/friends"
        ? Response.json({
            items: [{ player: { playerId: 42 } }],
            nextCursor: null,
          })
        : null,
  };
  let ctx = setup(directory, options);
  try {
    let entry = await ctx.service.identify(token);
    await issue(ctx.service, entry, "enable-buddy-42", "buddy.set", {
      playerId: 42,
      enabled: true,
    });
    assert.deepEqual(ctx.service.snapshot(entry).buddy.friendIds, [42]);
    assert.equal(ctx.service.snapshot(entry).subscription.enabled, false);
    await issue(ctx.service, entry, "buddy-settings-42", "buddy.configure", {
      boostersEnabled: true,
      fullBoosterReserve: 3,
      stashEnabled: true,
      stashReserve: 2,
    });
    assert.equal(ctx.service.snapshot(entry).buddyHelp.fullBoosterReserve, 3);
    ctx.close();
    ctx = setup(directory, options);
    entry = await ctx.service.identify(token);
    assert.deepEqual(ctx.service.snapshot(entry).buddy.friendIds, [42]);
    assert.equal(ctx.service.snapshot(entry).buddyHelp.stashReserve, 2);
    assert.equal(ctx.service.snapshot(entry).buddyHelp.boostersEnabled, true);
    await issue(ctx.service, entry, "buddy-refresh-42", "invitations.refresh");
    await entry.raidSubscription.tick();
    assert.equal(ctx.service.snapshot(entry).buddy.phase, "fighting");
    assert.equal(
      ctx.calls.filter(
        (call) => call.method === "POST" && call.path.endsWith("/accept"),
      ).length,
      1,
    );
    assert.ok(ctx.pendingBeforePost[0]);
    await issue(ctx.service, entry, "stop-buddy-fighting", "buddy.stop");
    assert.equal(ctx.service.snapshot(entry).buddy.enabled, false);
    assert.equal(ctx.service.snapshot(entry).buddy.phase, "fighting");
    assert.equal(ctx.service.snapshot(entry).buddy.hasSuspendedGoal, true);
    assert.equal(
      ctx.calls.filter(
        (call) => call.method === "POST" && call.path.endsWith("/accept"),
      ).length,
      1,
    );
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Buddy does not send boosters even when legacy settings are enabled", async () => {
  const directory = mkdtempSync(join(tmpdir(), "buddy-booster-worker-"));
  let observedPending = null;
  let ctx;
  const options = {
    invitations: () => [],
    extraRoute: (path, method) => {
      if (path === "/api/friends")
        return Response.json({
          items: [{ player: { playerId: 42 } }],
          nextCursor: null,
        });
      if (path === "/api/player-interactions/booster-requests/incoming")
        return Response.json({
          items: [
            {
              requestId: "buddy-req",
              playerId: 42,
              status: "pending",
              expiresAtUtc: future,
            },
          ],
          nextCursor: null,
        });
      if (path === "/api/me/bag")
        return Response.json({ boosters: { full: { count: 4 } } });
      if (
        path ===
          "/api/player-interactions/booster-requests/buddy-req/fulfill" &&
        method === "POST"
      ) {
        observedPending = ctx.store.read("101").buddyHelp.pending;
        return Response.json({ success: true });
      }
      return null;
    },
  };
  ctx = setup(directory, options);
  try {
    const entry = await ctx.service.identify(token);
    await issue(ctx.service, entry, "buddy-booster-friend", "buddy.set", {
      playerId: 42,
      enabled: true,
    });
    await issue(
      ctx.service,
      entry,
      "buddy-booster-settings",
      "buddy.configure",
      {
        boostersEnabled: true,
        fullBoosterReserve: 2,
        stashEnabled: false,
        stashReserve: 1,
      },
    );
    await ctx.service.boot();
    await new Promise((resolve) => setTimeout(resolve, 2700));
    assert.equal(observedPending, null);
    assert.equal(ctx.store.read("101").buddyHelp.pending, null);
    assert.equal(
      ctx.calls.filter(
        (call) => call.method === "POST" && call.path.includes("/fulfill"),
      ).length,
      0,
    );
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Buddy does not send stash items after restart with legacy settings", async () => {
  const directory = mkdtempSync(join(tmpdir(), "buddy-stash-worker-"));
  let pendingAtPost = null;
  let ctx;
  const options = {
    invitations: () => [],
    extraRoute: (path, method) => {
      if (path === "/api/friends")
        return Response.json({
          items: [{ player: { playerId: 42 } }],
          nextCursor: null,
        });
      if (path === "/api/stash/help-requests/42")
        return Response.json({
          items: [{ setId: 1, ingredientId: 2, ownedByMe: 3, canSend: true }],
          remainingToday: 2,
        });
      if (path === "/api/stash/help-gifts" && method === "POST") {
        pendingAtPost = ctx.store.read("101").buddyHelp.stashPending;
        return Response.json({ success: true });
      }
      return null;
    },
  };
  ctx = setup(directory, options);
  try {
    let entry = await ctx.service.identify(token);
    await issue(ctx.service, entry, "buddy-stash-friend", "buddy.set", {
      playerId: 42,
      enabled: true,
    });
    await issue(ctx.service, entry, "buddy-stash-settings", "buddy.configure", {
      boostersEnabled: false,
      fullBoosterReserve: 1,
      stashEnabled: true,
      stashReserve: 2,
    });
    ctx.close();
    ctx = setup(directory, options);
    await ctx.service.boot();
    await new Promise((resolve) => setTimeout(resolve, 2700));
    assert.equal(pendingAtPost, null);
    assert.equal(ctx.store.read("101").buddyHelp.stashPending, null);
    assert.equal(
      ctx.calls.filter(
        (call) =>
          call.method === "POST" && call.path === "/api/stash/help-gifts",
      ).length,
      0,
    );
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("manual Buddy resolution reads game state and records no-replay markers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "buddy-resolve-"));
  const options = {
    invitations: () => [],
    extraRoute: (path) => {
      if (path === "/api/player-interactions/booster-requests/incoming")
        return Response.json({ items: [], nextCursor: null });
      if (path === "/api/stash/help-requests/42")
        return Response.json({
          items: [{ setId: 1, ingredientId: 2 }],
          remainingToday: 1,
        });
      return null;
    },
  };
  let ctx = setup(directory, options);
  try {
    let entry = await ctx.service.identify(token);
    await issue(
      ctx.service,
      entry,
      "settings-before-pending",
      "buddy.configure",
      {
        boostersEnabled: false,
        fullBoosterReserve: 1,
        stashEnabled: false,
        stashReserve: 1,
      },
    );
    const saved = ctx.store.read("101");
    saved.buddyHelp.pending = {
      playerId: 42,
      requestId: "req-1",
      operationId: "secret-operation",
      expiresAt: now + 60000,
    };
    saved.buddyHelp.stashPending = {
      playerId: 42,
      setId: 1,
      ingredientId: 2,
      operationId: "secret-stash-operation",
    };
    ctx.store.write("101", saved);
    ctx.close();
    ctx = setup(directory, options);
    entry = await ctx.service.identify(token);
    assert.deepEqual(ctx.service.snapshot(entry).buddyHelp.pendingBooster, {
      playerId: 42,
    });
    assert.equal(
      JSON.stringify(ctx.service.snapshot(entry)).includes("secret-operation"),
      false,
    );
    await issue(
      ctx.service,
      entry,
      "resolve-booster-pending",
      "buddy.resolve",
      { kind: "booster" },
    );
    assert.equal(
      ctx.store.read("101").buddyHelp.completed[0].requestId,
      "req-1",
    );
    await issue(ctx.service, entry, "resolve-stash-pending", "buddy.resolve", {
      kind: "stash",
    });
    assert.deepEqual(ctx.store.read("101").buddyHelp.stashBlocked, [
      { playerId: 42, setId: 1, ingredientId: 2 },
    ]);
    assert.equal(
      ctx.calls.some((call) => call.method === "POST"),
      false,
    );
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stopping floor mode during a Buddy raid does not resume the floor-owned raid", async () => {
  const directory = mkdtempSync(join(tmpdir(), "buddy-floor-stop-"));
  let invited = false;
  let status = "active";
  const ctx = setup(directory, {
    omitActiveBossBattle: true,
    battleStatus: () => status,
    invitations: () =>
      invited
        ? [
            {
              invitationId: "invite-9",
              battleId: "battle-9",
              bossId: 7,
              leaderPlayerId: 9,
              inviterPlayerId: 42,
              peerPlayerId: 42,
              status: "pending",
              battleStatus: "active",
              expiresAtUtc: future,
              battleExpiresAtUtc: future,
            },
          ]
        : [],
    catalogue: {
      floors: [{ id: "a", code: "A" }],
      departments: [
        { id: "a1", floorId: "a", code: "A1" },
        { id: "a2", floorId: "a", code: "A2" },
      ],
      works: [],
      businesses: [],
      businessUpgrades: [],
      bosses: [{ id: "boss-7", apiId: "7", numericId: 7 }],
    },
    extraRoute: (path) => {
      if (path === "/api/friends")
        return Response.json({
          items: [{ player: { playerId: 42 } }],
          nextCursor: null,
        });
      if (path === "/api/floors")
        return Response.json([{ code: "A", isAvailable: true }]);
      if (path === "/api/floors/A/info")
        return Response.json({
          departments: [
            { blockCode: "A1", unlocked: true },
            {
              blockCode: "A2",
              unlocked: false,
              requirements: [
                { type: "boss_kills", bossId: 7, current: 0, required: 2 },
              ],
            },
          ],
        });
      return null;
    },
  });
  try {
    const entry = await ctx.service.identify(token);
    await issue(ctx.service, entry, "buddy-before-floor", "buddy.set", {
      playerId: 42,
      enabled: true,
    });
    await issue(ctx.service, entry, "floor-before-buddy", "floor.start");
    await entry.floorRunner.tick();
    assert.equal(ctx.service.snapshot(entry).floorRunner.phase, "executing");
    invited = true;
    await issue(ctx.service, entry, "read-buddy-invite", "invitations.refresh");
    await entry.raidSubscription.tick();
    assert.equal(ctx.service.snapshot(entry).buddy.phase, "fighting");
    assert.equal(
      ctx.store.read("101").raidSubscription.checkpoint.floorOwned,
      true,
    );
    await entry.raidSubscription.tick();
    assert.equal(ctx.service.snapshot(entry).auto.enabled, true);
    await issue(ctx.service, entry, "floor-stop-buddy", "floor.stop");
    assert.equal(ctx.service.snapshot(entry).floorRunner.status, "stopped");
    assert.equal(ctx.service.snapshot(entry).auto.enabled, true);
    assert.equal(
      ctx.store.read("101").raidSubscription.checkpoint.raidEnabled,
      false,
    );
    status = "won";
    invited = false;
    await entry.controller.refresh();
    await entry.raidSubscription.tick();
    ctx.setNow(now + 601000);
    await issue(
      ctx.service,
      entry,
      "buddy-after-floor-stop",
      "invitations.refresh",
    );
    await entry.raidSubscription.tick();
    assert.equal(ctx.service.snapshot(entry).buddy.phase, "monitoring");
    assert.equal(ctx.service.snapshot(entry).raid.enabled, false);
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restart finishes discarding floor-owned work after a stop interrupted during Buddy", async () => {
  const directory = mkdtempSync(join(tmpdir(), "buddy-floor-crash-"));
  let ctx = setup(directory, { invitations: () => [] });
  try {
    const entry = await ctx.service.identify(token);
    await issue(ctx.service, entry, "floor-crash-seed-1", "buddy.configure", {
      boostersEnabled: false,
      fullBoosterReserve: 1,
      stashEnabled: false,
      stashReserve: 1,
    });
    const saved = ctx.store.read("101");
    saved.floorRunner = { status: "stopped", phase: "idle", target: null };
    saved.raid = { enabled: true, status: "waiting", bossId: 7 };
    saved.raidSubscription = {
      mode: "buddy",
      enabled: true,
      phase: "fighting",
      friendIds: [42],
      bossId: 7,
      battleId: "battle-9",
      lastReadAt: now,
      lastSeenAt: now,
      checkpoint: {
        floorOwned: true,
        floorTarget: { kind: "boss", apiId: 7 },
        bossId: 7,
        goal: null,
        auto: null,
        raidEnabled: true,
        businessRunning: false,
        workRunning: false,
      },
    };
    ctx.store.write("101", saved);
    ctx.close();
    ctx = setup(directory, { invitations: () => [] });
    const recovered = await ctx.service.identify(token);
    assert.equal(ctx.service.snapshot(recovered).raid.enabled, false);
    assert.equal(
      ctx.store.read("101").raidSubscription.checkpoint.raidEnabled,
      false,
    );
    assert.equal(ctx.store.read("101").raidSubscription.phase, "fighting");
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("queued invitation captures server identity and joins once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "queued-invitation-"));
  const ctx = setup(directory);
  try {
    const entry = await ctx.service.identify(token);
    await issue(ctx.service, entry, "queue-inv-read", "invitations.refresh");
    await ctx.service.boot();
    await issue(ctx.service, entry, "queue-inv-join", "queue.enqueue", {
      type: "invitation.accept",
      action: { invitationId: "invite-9", bossId: 999 },
    });
    const end = Date.now() + 4000;
    while (
      Date.now() < end &&
      ctx.service.snapshot(entry).queuedActions[0].status !== "completed"
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    const state = ctx.service.snapshot(entry);
    assert.equal(state.queuedActions[0].status, "completed");
    assert.equal(state.queuedActions[0].args.bossId, 7);
    assert.equal(state.queuedActions[0].priority, 60);
    assert.equal(state.battle.battle.id, "battle-9");
    assert.equal(
      ctx.calls.filter(
        (call) => call.method === "POST" && call.path.endsWith("/accept"),
      ).length,
      1,
    );
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("queued invitation with lost response is reconciled after restart without replay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "queued-invitation-lost-"));
  let ctx = setup(directory, { timeoutPost: true });
  try {
    let entry = await ctx.service.identify(token);
    await issue(ctx.service, entry, "queue-lost-read", "invitations.refresh");
    await ctx.service.boot();
    await issue(ctx.service, entry, "queue-lost-join", "queue.enqueue", {
      type: "invitation.accept",
      action: { invitationId: "invite-9" },
    });
    let end = Date.now() + 4000;
    while (
      Date.now() < end &&
      ctx.service.snapshot(entry).queuedActions[0].status !== "reconciling"
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      ctx.service.snapshot(entry).queuedActions[0].status,
      "reconciling",
    );
    assert.equal(ctx.store.read("101").manualBattle.pending.kind, "invitation");
    assert.equal(
      ctx.calls.filter(
        (call) => call.method === "POST" && call.path.endsWith("/accept"),
      ).length,
      1,
    );
    ctx.close();
    ctx = setup(directory, { now: now + 30000 });
    await ctx.service.boot();
    entry = await ctx.service.identify(token);
    end = Date.now() + 4000;
    while (
      Date.now() < end &&
      ctx.service.snapshot(entry).queuedActions[0].status !== "completed"
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      ctx.service.snapshot(entry).queuedActions[0].status,
      "completed",
    );
    assert.equal(ctx.service.snapshot(entry).battle.battle.id, "battle-9");
    assert.equal(
      ctx.calls.filter(
        (call) => call.method === "POST" && call.path.endsWith("/accept"),
      ).length,
      0,
    );
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a rate-limited queued invitation remains uncertain until its retry deadline", async () => {
  const directory = mkdtempSync(join(tmpdir(), "queued-invite-rate-limit-"));
  const ctx = setup(directory, { rateLimitPost: true });
  try {
    const entry = await ctx.service.identify(token);
    await issue(
      ctx.service,
      entry,
      "read-before-invite",
      "invitations.refresh",
    );
    await ctx.service.boot();
    await issue(ctx.service, entry, "rate-limit-invite", "queue.enqueue", {
      type: "invitation.accept",
      action: { invitationId: "invite-9" },
    });
    const end = Date.now() + 4000;
    while (
      Date.now() < end &&
      ctx.service.snapshot(entry).queuedActions[0].status !== "reconciling"
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    const job = ctx.store.read("101").queuedActions[0];
    assert.equal(job.status, "reconciling");
    assert.equal(job.nextAt, now + 120000);
    assert.ok(ctx.store.read("101").manualBattle.pending);
    assert.equal(
      ctx.calls.filter(
        (call) => call.method === "POST" && call.path.endsWith("/accept"),
      ).length,
      1,
    );
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a rate-limited invitation reconciliation stops before further reads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "invite-refresh-rate-limit-"));
  const options = { timeoutPost: true };
  const ctx = setup(directory, options);
  try {
    const entry = await ctx.service.identify(token);
    await issue(ctx.service, entry, "read-invite-first", "invitations.refresh");
    await assert.rejects(
      issue(ctx.service, entry, "accept-lost-invite", "invitations.accept", {
        invitationId: "invite-9",
      }),
    );
    options.rateLimitBattleRead = true;
    const before = ctx.calls.length;
    await assert.rejects(
      issue(ctx.service, entry, "refresh-rate-limited", "invitations.refresh"),
      (error) => error.retryAfterMs === 120000,
    );
    assert.deepEqual(
      ctx.calls.slice(before).map((call) => call.path),
      ["/api/bosses/battles/battle-9"],
    );
    assert.ok(ctx.store.read("101").battle.pendingInvitation);
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
