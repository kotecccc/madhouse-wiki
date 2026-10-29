import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceGlobalRaidDay,
  observeGlobalInvitations,
  refreshGlobalRaidRows,
  formatGlobalRaidSummary,
  createGlobalRaidsWorker,
} from "./global-raids-worker.mjs";
import { projectBossInvitations } from "./boss-invitations.mjs";

const minute = 60000;
const start = Date.parse("2026-10-29T20:00:00Z");
const invitation = (n, at, extra = {}) => ({
  invitationId: `i${n}`,
  battleId: `b${n}`,
  bossId: 7,
  leaderPlayerId: 42,
  inviterPlayerId: 99,
  peerPlayerId: 99,
  peerNickname: "Чужой",
  status: "pending",
  battleStatus: "active",
  expiresAtUtc: new Date(at + 120000).toISOString(),
  battleExpiresAtUtc: new Date(at + 120000).toISOString(),
  ...extra,
});
async function observe(state, who, items, now) {
  const raw = { items };
  const p = await projectBossInvitations(raw, () => ({ name: "Босс" }), now);
  return observeGlobalInvitations(state, who, raw, p, now);
}
async function series() {
  let state = advanceGlobalRaidDay({}, start);
  for (let i = 0; i < 6; i++)
    state = await observe(
      state,
      "1",
      [invitation(i, start + i * minute)],
      start + i * minute,
    );
  return state;
}
const format = (state, now) =>
  formatGlobalRaidSummary(refreshGlobalRaidRows(state, now), now, () => ({
    name: "Босс",
  }));

test("counts six distinct invitation battles once across accounts and never uses inviter name as leader", async () => {
  let state = await series();
  state = await observe(
    state,
    "2",
    [invitation(5, start + 5 * minute)],
    start + 5 * minute,
  );
  assert.equal(state.raids.length, 1);
  assert.equal(state.raids[0].count, 6);
  assert.match(format(state, start + 5 * minute), /Игрок №42/);
  assert.doesNotMatch(format(state, start + 5 * minute), /Чужой/);
  state = await observe(
    state,
    "1",
    [
      invitation(5, start + 6 * minute, {
        inviterPlayerId: 42,
        peerPlayerId: 42,
        peerNickname: "Ведущий",
      }),
    ],
    start + 6 * minute,
  );
  assert.equal(state.raids[0].count, 6);
  assert.match(format(state, start + 6 * minute), /Ведущий/);
});

test("status follows the three, ten and thirty minute boundaries", async () => {
  let state = await series();
  assert.match(format(state, start + 5 * minute), /🔵 Идёт/);
  state = await observe(state, "1", [], start + 6 * minute);
  assert.match(format(state, start + 6 * minute), /🔵 Идёт/);
  state = await observe(state, "1", [], start + 8 * minute);
  assert.match(format(state, start + 8 * minute), /⚪ Ждёт/);
  state = await observe(state, "1", [], start + 9 * minute);
  assert.match(format(state, start + 9 * minute), /⚪ Ждёт/);
  state = await observe(state, "1", [], start + 15 * minute);
  assert.match(format(state, start + 15 * minute), /🟡 Пауза · 10 мин/);
  state = await observe(state, "1", [], start + 16 * minute);
  assert.match(format(state, start + 16 * minute), /🟡 Пауза · 11 мин/);
  state = await observe(state, "1", [], start + 35 * minute);
  assert.match(format(state, start + 35 * minute), /🔴 Завершён/);
  assert.match(format(state, start + 40 * minute), /Нет данных/);
});

test("only a continuing series and its count cross midnight; active battle remains deduplicated", async () => {
  let state = await series();
  const midnight = Date.parse("2026-10-29T21:00:00Z");
  state = await observe(
    state,
    "1",
    [invitation(5, midnight - minute)],
    midnight - minute,
  );
  state = advanceGlobalRaidDay(state, midnight);
  assert.equal(state.raids[0].count, 6);
  state = await observe(
    state,
    "1",
    [invitation(5, midnight + minute)],
    midnight + minute,
  );
  assert.equal(state.raids[0].count, 6);
  state = await observe(
    state,
    "1",
    [invitation(6, midnight + 2 * minute)],
    midnight + 2 * minute,
  );
  assert.equal(state.raids[0].count, 7);
  state = refreshGlobalRaidRows(state, midnight + 2 * minute);
  assert.equal(state.raids[0].count, 7);
});

test("unknown send outcome is checkpointed and never sent again", async () => {
  let time = start;
  let data;
  let sends = 0;
  const store = {
    readGlobalRaids: () => structuredClone(data),
    writeGlobalRaids: (v) => {
      data = structuredClone(v);
    },
  };
  const worker = createGlobalRaidsWorker({
    store,
    owner: "w",
    now: () => time,
    telegram: {
      request: async () => {
        sends++;
        throw Error("unknown");
      },
    },
    chatId: "-1",
    getBoss: () => ({}),
    isClosed: () => false,
  });
  await worker.tick();
  time += 6 * minute;
  await worker.tick();
  assert.equal(sends, 1);
  assert.equal(data.pendingSend, true);
});

test("a slow publish schedules the next attempt after completion", async () => {
  let time = start;
  let data;
  let sends = 0;
  const store = {
    readGlobalRaids: () => structuredClone(data),
    writeGlobalRaids: (v) => {
      data = structuredClone(v);
    },
  };
  const worker = createGlobalRaidsWorker({
    store,
    owner: "w",
    now: () => time,
    telegram: {
      request: async () => {
        sends++;
        time += minute;
        return { message_id: 1 };
      },
    },
    chatId: "-1",
    getBoss: () => ({}),
    isClosed: () => false,
  });
  await worker.tick();
  await worker.tick();
  assert.equal(sends, 1);
});

test("two observations are insufficient and old observations do not meet the two-hour threshold", async () => {
  let state = advanceGlobalRaidDay({}, start);
  for (let i = 0; i < 2; i++)
    state = await observe(
      state,
      "1",
      [invitation(i, start + i * minute)],
      start + i * minute,
    );
  assert.equal(state.raids.length, 0);
  state = await observe(
    state,
    "1",
    [invitation(2, start + 122 * minute)],
    start + 122 * minute,
  );
  assert.equal(state.raids.length, 0);
});

test("updates observed during Telegram send remain durable", async () => {
  let time = start,
    data,
    finish,
    started;
  const begun = new Promise((resolve) => {
    started = resolve;
  });
  const store = {
    readGlobalRaids: () => structuredClone(data),
    writeGlobalRaids: (v) => {
      data = structuredClone(v);
    },
  };
  const worker = createGlobalRaidsWorker({
    store,
    owner: "w",
    now: () => time,
    chatId: "-1",
    getBoss: () => ({}),
    isClosed: () => false,
    telegram: {
      request: () => {
        started();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  });
  const pending = worker.tick();
  await begun;
  for (let i = 0; i < 6; i++) {
    const raw = { items: [invitation(i, time)] };
    const projected = await projectBossInvitations(
      raw,
      () => ({ name: "Босс" }),
      time,
    );
    worker.observe("1", raw, projected);
    time += minute;
  }
  finish({ message_id: 15 });
  await pending;
  assert.equal(data.raids[0].count, 6);
  assert.equal(data.messageId, 15);
  assert.equal(data.pendingSend, false);
});

test("fewer than three battles in the two-hour window do not trigger an active raid", async () => {
  const base = start - 4 * 60 * minute;
  let state = advanceGlobalRaidDay({}, base);
  for (let i = 0; i < 3; i++)
    state = await observe(
      state,
      "1",
      [invitation(i, base + i * 61 * minute)],
      base + i * 61 * minute,
    );
  assert.equal(state.raids.length, 0);
});

test("partial responses do not erase prior evidence", async () => {
  const state = await series();
  const before = structuredClone(state);
  observeGlobalInvitations(
    state,
    "1",
    { items: [], partial: true },
    [],
    start + 6 * minute,
  );
  assert.deepEqual(state, before);
});

test("a potentially truncated invitation page does not prove an earlier invitation disappeared", async () => {
  const state = await series();
  const before = structuredClone(state.observations.b5.sources["1"]);
  const items = Array.from({ length: 100 }, (_, i) => ({
    invitationId: `invalid-${i}`,
  }));
  observeGlobalInvitations(state, "1", { items }, [], start + 6 * minute);
  assert.deepEqual(state.observations.b5.sources["1"], before);
});

test("migration retains the current message and continuing raid count", async () => {
  let data = {
    day: "2026-10-29",
    messageId: 31,
    pendingSend: false,
    nextPublishAt: 0,
    observations: {},
    raids: [
      {
        key: "42:7",
        leaderPlayerId: 42,
        bossId: 7,
        lastBattleAt: start,
        count: 8,
        active: true,
        activeId: "b7",
      },
    ],
  };
  const calls = [];
  const worker = createGlobalRaidsWorker({
    store: {
      readGlobalRaids: () => structuredClone(data),
      writeGlobalRaids: (v) => {
        data = structuredClone(v);
      },
    },
    owner: "w",
    now: () => start,
    chatId: "-1",
    getBoss: () => ({}),
    isClosed: () => false,
    telegram: {
      request: async (method) => {
        calls.push(method);
        return true;
      },
    },
  });
  await worker.tick();
  assert.deepEqual(calls, ["editMessageText"]);
  assert.equal(data.raids[0].count, 8);
  assert.equal(data.messageId, 31);
});

test("updates the same message after one minute without changing status thresholds", async () => {
  let time = start;
  let data;
  const methods = [];
  const store = {
    readGlobalRaids: () => structuredClone(data),
    writeGlobalRaids: (value) => {
      data = structuredClone(value);
    },
  };
  const worker = createGlobalRaidsWorker({
    store,
    owner: "worker",
    now: () => time,
    chatId: "-1",
    getBoss: () => ({}),
    isClosed: () => false,
    telegram: {
      request: async (method) => {
        methods.push(method);
        return method === "sendRichMessage" ? { message_id: 7 } : true;
      },
    },
  });
  await worker.tick();
  time += 30000;
  await worker.tick();
  assert.deepEqual(methods, ["sendRichMessage"]);
  time += 30000;
  await worker.tick();
  assert.deepEqual(methods, ["sendRichMessage", "editMessageText"]);
});

test("the message omits the removed informational lines", async () => {
  const text = format(await series(), start + 5 * minute);
  assert.doesNotMatch(text, /Время: МСК|Замечено боёв · по приглашениям/);
  assert.match(text, /<td>Игрок №42<\/td><td>6<\/td>/);
  assert.match(text, /<table bordered striped>/);
});

test("existing TMA history makes the active raid visible and deduplicates overlapping accounts", async () => {
  let state = advanceGlobalRaidDay({}, start);
  const raw = {
    items: [
      invitation(9, start, {
        leaderPlayerId: 42,
        inviterPlayerId: 42,
        peerPlayerId: 42,
        peerNickname: "Лидер",
      }),
    ],
  };
  const projected = await projectBossInvitations(
    raw,
    () => ({ name: "Босс" }),
    start,
  );
  const history = [
    {
      leaderPlayerId: 42,
      bossId: 7,
      battleId: "old-1",
      seenAt: start - 90 * minute,
    },
    {
      leaderPlayerId: 42,
      bossId: 7,
      battleId: "old-2",
      seenAt: start - 50 * minute,
    },
    { leaderPlayerId: 42, bossId: 7, battleId: "b9", seenAt: start - minute },
  ];
  state = observeGlobalInvitations(state, "1", raw, projected, start, history);
  state = observeGlobalInvitations(state, "2", raw, projected, start, history);
  assert.equal(state.raids.filter((row) => row.active).length, 1);
  assert.equal(state.raids.find((row) => row.active).count, 3);
  assert.match(format(state, start), /🔵 Идёт.*Лидер.*3/);
});

test("a stored history without a currently available invitation does not assert an active raid", () => {
  const history = [
    { leaderPlayerId: 42, bossId: 7, battleId: "old", seenAt: start - minute },
  ];
  const state = observeGlobalInvitations(
    advanceGlobalRaidDay({}, start),
    "1",
    { items: [] },
    [],
    start,
    history,
  );
  assert.equal(Object.keys(state.observations).length, 0);
  assert.equal(state.raids.length, 0);
});

test("TMA histories from multiple accounts count a shared battle once even when one observation is older than the window", async () => {
  let state = advanceGlobalRaidDay({}, start);
  const raw = {
    items: [
      invitation(9, start, {
        leaderPlayerId: 42,
        inviterPlayerId: 42,
        peerPlayerId: 42,
      }),
    ],
  };
  const projected = await projectBossInvitations(
    raw,
    () => ({ name: "Босс" }),
    start,
  );
  const observations = [
    { leaderPlayerId: 42, bossId: 7, battleId: "a", seenAt: start - minute },
    { leaderPlayerId: 42, bossId: 7, battleId: "b", seenAt: start - minute },
    { leaderPlayerId: 42, bossId: 7, battleId: "b9", seenAt: start - minute },
  ];
  state.observations.a = {
    id: "a",
    leaderPlayerId: 42,
    bossId: 7,
    firstSeen: start - 121 * minute,
    lastSeen: start - 121 * minute,
    sources: {},
  };
  state = observeGlobalInvitations(
    state,
    "1",
    raw,
    projected,
    start,
    observations,
  );
  state = observeGlobalInvitations(
    state,
    "2",
    raw,
    projected,
    start,
    observations,
  );
  assert.equal(state.raids.filter((row) => row.active).length, 1);
  assert.equal(state.raids.find((row) => row.active).count, 3);
});

test("existing text message is edited with a native rich table preserving raid content", async () => {
  let data = await series();
  data.messageId = 5;
  data.nextPublishAt = 0;
  let request;
  const worker = createGlobalRaidsWorker({
    store: {
      readGlobalRaids: () => structuredClone(data),
      writeGlobalRaids: (v) => {
        data = structuredClone(v);
      },
    },
    owner: "worker",
    now: () => start + 5 * minute,
    chatId: "@channel",
    getBoss: () => ({ name: "Босс <опасно>", departmentId: "dept-J3" }),
    isClosed: () => false,
    telegram: {
      request: async (method, payload) => {
        request = { method, payload };
        return true;
      },
    },
  });
  await worker.tick();
  assert.equal(request.method, "editMessageText");
  assert.equal(request.payload.message_id, 5);
  assert.equal(request.payload.text, undefined);
  assert.match(request.payload.rich_message.html, /<table bordered striped>/);
  assert.match(
    request.payload.rich_message.html,
    /<th>Статус<\/th><th>Зона<\/th><th>Босс<\/th><th>Ведущий<\/th><th>Бои<\/th>/,
  );
  assert.match(
    request.payload.rich_message.html,
    /<td>🔵 Идёт<\/td><td>J3<\/td><td>Босс &lt;опасно&gt;<\/td><td>Игрок №42<\/td><td>6<\/td>/,
  );
  assert.equal(data.messageId, 5);
});

test("custom status emoji are opt-in and preserve the four status meanings", () => {
  const now = start + 40 * minute;
  const rows = [
    { active: true, fresh: true, lastBattleAt: now },
    { active: false, fresh: true, lastBattleAt: now - 4 * minute },
    { active: false, fresh: true, lastBattleAt: now - 11 * minute },
    { active: false, fresh: true, lastBattleAt: now - 31 * minute },
  ].map((row, i) => ({
    ...row,
    bossId: i + 1,
    leaderPlayerId: i + 1,
    count: 3,
  }));
  const state = { day: "2026-10-29", raids: rows };
  const normal = formatGlobalRaidSummary(state, now, () => ({ name: "Босс" }));
  assert.doesNotMatch(normal, /<tg-emoji/);
  const custom = formatGlobalRaidSummary(state, now, () => ({ name: "Босс" }), {
    customEmoji: true,
  });
  for (const id of [
    "5819095256267755019",
    "5819143265412189249",
    "5819028847483423716",
    "5818665600624365278",
  ])
    assert.match(custom, new RegExp(`emoji-id="${id}"`));
  assert.match(custom, /<\/tg-emoji> Идёт/);
  assert.match(custom, /<\/tg-emoji> Ждёт/);
  assert.match(custom, /<\/tg-emoji> Пауза/);
  assert.match(custom, /<\/tg-emoji> Завершён/);
});

test("a preflight failure clears the send checkpoint without publishing", async () => {
  let time = start;
  let data;
  let attempts = 0;
  const store = {
    readGlobalRaids: () => structuredClone(data),
    writeGlobalRaids: (value) => {
      data = structuredClone(value);
    },
  };
  const worker = createGlobalRaidsWorker({
    store,
    owner: "worker",
    now: () => time,
    chatId: "@channel",
    getBoss: () => ({}),
    isClosed: () => false,
    telegram: {
      request: async () => {
        attempts++;
        throw Object.assign(new Error("session unavailable"), {
          notDispatched: true,
        });
      },
    },
  });
  await worker.tick();
  assert.equal(data.pendingSend, false);
  time += 60000;
  await worker.tick();
  assert.equal(attempts, 2);
});

test("a quiet raid is not carried over at the exact thirty-minute boundary", () => {
  const midnight = Date.parse("2026-10-29T21:00:00Z");
  const state = advanceGlobalRaidDay(
    {
      day: "2026-10-29",
      raids: [
        {
          key: "42:7",
          active: false,
          lastBattleAt: midnight - 30 * minute,
          count: 6,
        },
      ],
      observations: {},
    },
    midnight,
  );
  assert.equal(state.raids.length, 0);
});
