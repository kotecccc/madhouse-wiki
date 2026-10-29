import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceGlobalRaidDay,
  observeGlobalInvitations,
  refreshGlobalRaidRows,
  formatGlobalRaidSummary,
  formatGlobalRaidPages,
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
const format = (state, now) => {
  const refreshed = refreshGlobalRaidRows(state, now);
  return formatGlobalRaidSummary(
    {
      ...refreshed,
      raids: refreshed.raids.map((row) => ({
        ...row,
        count: Math.max(row.count, 10),
      })),
    },
    now,
    () => ({ name: "Босс" }),
  );
};

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
  assert.match(
    format(state, start + 5 * minute),
    /text="42">ID 42<\/tg-button>/,
  );
  assert.doesNotMatch(format(state, start + 5 * minute), /Чужой/);
  state = await observe(
    state,
    "1",
    [
      invitation(5, start + 6 * minute, {
        inviterPlayerId: 42,
        peerPlayerId: 42,
        peerNickname: "Ведущий",
        peerUsername: "leadername",
      }),
    ],
    start + 6 * minute,
  );
  assert.equal(state.raids[0].count, 6);
  assert.match(
    format(state, start + 6 * minute),
    /<tg-button type="copy_text" text="@leadername">@leadername<\/tg-button>/,
  );
  assert.doesNotMatch(format(state, start + 6 * minute), /<td>Ведущий/);
});

test("status follows the three, ten and thirty minute boundaries", async () => {
  let state = await series();
  assert.match(format(state, start + 5 * minute), /🔵/);
  state = await observe(state, "1", [], start + 6 * minute);
  assert.match(format(state, start + 6 * minute), /🔵/);
  state = await observe(state, "1", [], start + 8 * minute);
  assert.match(format(state, start + 8 * minute), /⚪/);
  state = await observe(state, "1", [], start + 9 * minute);
  assert.match(format(state, start + 9 * minute), /⚪/);
  state = await observe(state, "1", [], start + 15 * minute);
  assert.match(format(state, start + 15 * minute), /🟡/);
  state = await observe(state, "1", [], start + 16 * minute);
  assert.match(format(state, start + 16 * minute), /🟡/);
  state = await observe(state, "1", [], start + 35 * minute);
  assert.match(format(state, start + 35 * minute), /Активных рейдов пока нет/);
  assert.match(format(state, start + 40 * minute), /Активных рейдов пока нет/);
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
  assert.match(text, /text="42">ID 42<\/tg-button>/);
  assert.match(text, /<table bordered striped compact>/);
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
  assert.match(format(state, start), /🔵.*text="Лидер">Лидер<\/tg-button>/);
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
  for (let i = 6; i < 10; i++)
    data = await observe(
      data,
      "1",
      [
        invitation(i, start + i * minute, {
          inviterPlayerId: 42,
          peerPlayerId: 42,
          peerUsername: "leadername",
        }),
      ],
      start + i * minute,
    );
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
    now: () => start + 9 * minute,
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
  assert.match(
    request.payload.rich_message.html,
    /<table bordered striped compact>/,
  );
  assert.match(
    request.payload.rich_message.html,
    /<th>Зона<\/th><th>Босс<\/th><th>Боев<\/th><th>Ведущий<\/th>/,
  );
  assert.match(
    request.payload.rich_message.html,
    /<td>🔵 J3<\/td><td>Босс &lt;опасно&gt;<\/td><td>10<\/td><td><tg-button type="copy_text" text="@leadername">@leadername<\/tg-button><\/td>/,
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
    count: 10,
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
  ])
    assert.match(custom, new RegExp(`emoji-id="${id}"`));
  assert.doesNotMatch(custom, /Идёт|Ждёт|Пауза/);
  assert.doesNotMatch(custom, /Завершён/);
});

test("boss emoji match the boss and are only included for custom emoji publishing", () => {
  const now = start + 40 * minute;
  const state = {
    day: "2026-10-29",
    raids: [
      {
        bossId: 1,
        leaderPlayerId: 1,
        count: 10,
        active: true,
        lastBattleAt: now,
      },
    ],
  };
  const boss = () => ({ name: "Освальд «Исповедник»" });
  const custom = formatGlobalRaidSummary(state, now, boss, {
    customEmoji: true,
  });
  assert.match(
    custom,
    /<tg-emoji emoji-id="5413444820750348416">👹<\/tg-emoji> Освальд «Исповедник»/,
  );
  assert.doesNotMatch(formatGlobalRaidSummary(state, now, boss), /<tg-emoji/);
  assert.doesNotMatch(
    formatGlobalRaidSummary(state, now, () => ({ name: "Незнакомый" }), {
      customEmoji: true,
    }),
    /👹/,
  );
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

test("summary hides raids below ten and finished raids, sorts floors ascending, and shows copyable usernames", () => {
  const now = start + 60 * minute;
  const rows = [
    {
      bossId: 1,
      count: 10,
      active: true,
      lastBattleAt: now,
      leaderUsername: "higher_user",
      leaderName: "Not displayed",
    },
    {
      bossId: 2,
      count: 9,
      active: true,
      lastBattleAt: now,
      leaderUsername: "too_few",
    },
    {
      bossId: 3,
      count: 20,
      active: false,
      fresh: true,
      lastBattleAt: now - 30 * minute,
      leaderUsername: "finished_user",
    },
    {
      bossId: 4,
      count: 14,
      active: true,
      lastBattleAt: now,
      leaderUsername: "lower_user",
    },
    {
      bossId: 5,
      count: 10,
      active: true,
      lastBattleAt: now,
      leaderName: "No verified username",
    },
    {
      bossId: 6,
      count: 12,
      active: true,
      lastBattleAt: now,
      leaderUsername: "dollar_user",
    },
  ];
  const boss = {
    1: { name: "Босс J", departmentId: "dept-J3" },
    2: { name: "Мало", departmentId: "dept-A1" },
    3: { name: "Конец", departmentId: "dept-A1" },
    4: { name: "Босс A", departmentId: "dept-A2" },
    5: { name: "Без имени", departmentId: "dept-A1" },
    6: { name: "Доллар", departmentId: "dept-$1" },
  };
  const text = formatGlobalRaidSummary(
    { day: "2026-10-29", raids: rows },
    now,
    (id) => boss[id],
  );
  assert.doesNotMatch(text, /too_few|finished_user|Not displayed/);
  assert.match(text, /text="@lower_user">@lower_user<\/tg-button>/);
  assert.match(
    text,
    /<td>Без имени<\/td><td>10<\/td><td><tg-button type="copy_text" text="No verified username">No verified username<\/tg-button><\/td>/,
  );
  assert.ok(text.indexOf("Без имени") < text.indexOf("Босс A"));
  assert.ok(text.indexOf("Босс A") < text.indexOf("Босс J"));
  assert.ok(text.indexOf("Босс J") < text.indexOf("Доллар"));
  assert.match(text, /<td>🔵 \$1<\/td>/);
});

test("overflow keeps active raids first, then newer waits and pauses", () => {
  const now = start + 60 * minute;
  const raids = Array.from({ length: 60 }, (_, i) => ({
    bossId: i + 1,
    leaderPlayerId: i + 1,
    count: 10,
    fresh: true,
    active: i < 4,
    lastBattleAt:
      now -
      (i < 4
        ? 0
        : i < 12
          ? (3 + (i - 4) / 2) * minute
          : (10 + (i - 12) / 3) * minute),
    leaderName: `Лидер${i}`,
  }));
  const html = formatGlobalRaidSummary(
    { day: "2026-10-29", raids },
    now,
    (id) => ({ name: `Босс-${id}` }),
    { maxMessageLength: 3500 },
  );
  assert.ok(html.length <= 3500);
  for (let i = 1; i <= 4; i++) assert.ok(html.includes(`Босс-${i}<`));
  assert.ok(html.includes("Босс-5<"));
  assert.ok(!html.includes("Босс-60<"));
  const shown = (html.match(/<tr><td>/g) || []).length;
  assert.match(html, new RegExp(`Ещё рейдов: ${60 - shown}`));
});

test("overflow chooses higher floors then more battles, but displays floors ascending", () => {
  const now = start + minute;
  const raids = Array.from({ length: 80 }, (_, i) => ({
    bossId: i + 1,
    leaderPlayerId: i + 1,
    count: 10 + i,
    active: true,
    lastBattleAt: now,
    leaderName: `Лидер${i}`,
  }));
  const boss = (id) => ({
    name: `Босс-${id}`,
    departmentId: id <= 24 ? "dept-A1" : "dept-J1",
  });
  const html = formatGlobalRaidSummary(
    { day: "2026-10-29", raids },
    now,
    boss,
    { maxMessageLength: 3500 },
  );
  assert.ok(html.length <= 3500);
  assert.ok(html.includes("Босс-80<"));
  assert.ok(!html.includes("Босс-1<"));
  assert.ok(!html.includes("Босс-25<"));
  assert.ok(html.indexOf("Босс-79<") < html.indexOf("Босс-80<"));
});

test("overflow prioritizes the floor, distinct bosses and named leaders, and includes all remaining raids in continuation pages", () => {
  const now = start + minute;
  const make = (bossId, leaderPlayerId, count, extra = {}) => ({
    bossId,
    leaderPlayerId,
    count,
    active: true,
    lastBattleAt: now,
    ...extra,
  });
  const raids = [
    make(1, 1, 999),
    make(1, 2, 10, { leaderUsername: "named_leader" }),
    ...Array.from({ length: 50 }, (_, i) =>
      make(i + 2, i + 3, 10, { leaderName: `Имя${i}` }),
    ),
    make(100, 100, 9999, { leaderName: "Нижний" }),
  ];
  const boss = (id) => ({
    name: `Босс-${id}`,
    departmentId: id === 100 ? "dept-A1" : "dept-J1",
  });
  const pages = formatGlobalRaidPages({ day: "2026-10-29", raids }, now, boss, {
    continuationUrl: "https://t.me/raids/42",
    maxMessageLength: 3500,
  });
  assert.ok(pages.length > 1);
  assert.ok(pages.every((page) => page.length <= 3500));
  assert.match(pages[0], /text="@named_leader"/);
  assert.doesNotMatch(pages[0], /text="1">ID 1/);
  assert.doesNotMatch(pages[0], /Босс-100</);
  assert.match(pages[0], /href="https:\/\/t.me\/raids\/42"/);
  assert.match(pages.slice(1).join(""), /Босс-100</);
  assert.equal(pages.join("").match(/<tr><td>/g).length, raids.length);
});

test("continuation sends are checkpointed, reused and not repeated after uncertain delivery", async () => {
  let time = start + 10 * minute;
  let data = advanceGlobalRaidDay({}, time);
  data.raids = Array.from({ length: 55 }, (_, i) => {
    const base = {
      bossId: i + 1,
      leaderPlayerId: i + 1,
      count: 10,
      lastBattleAt: time,
      activeIds: [],
      leaderName: `Лидер${i}`,
      sources: {},
    };
    return { ...base, carried: true, base };
  });
  const calls = [];
  let uncertain = false;
  const worker = createGlobalRaidsWorker({
    store: {
      readGlobalRaids: () => structuredClone(data),
      writeGlobalRaids: (v) => {
        data = structuredClone(v);
      },
    },
    owner: "test",
    now: () => time,
    isClosed: () => false,
    maxMessageLength: 3500,
    chatId: "@channel",
    getBoss: (id) => ({ name: `Босс-${id}`, departmentId: "dept-J1" }),
    telegram: {
      request: async (method, payload) => {
        calls.push({ method, payload });
        if (method === "sendRichMessage" && calls.length === 2 && !uncertain) {
          uncertain = true;
          throw new Error("unknown outcome");
        }
        return { message_id: 101 };
      },
    },
  });
  await worker.tick();
  assert.equal(data.messageId, 101);
  assert.equal(data.continuations[0].pendingSend, true);
  time += minute;
  await worker.tick();
  assert.equal(
    calls.filter((call) => call.method === "sendRichMessage").length,
    1 + 1,
  );
  assert.equal(
    calls.filter((call) => call.method === "editMessageText").length,
    1,
  );
});

test("continuation messages are reused and linked from the next main update", async () => {
  let time = start + 10 * minute;
  let data = advanceGlobalRaidDay({}, time);
  data.raids = Array.from({ length: 55 }, (_, i) => {
    const base = {
      bossId: i + 1,
      leaderPlayerId: i + 1,
      count: 10,
      lastBattleAt: time,
      activeIds: [],
      leaderName: `Лидер${i}`,
      sources: {},
    };
    return { ...base, carried: true, base };
  });
  const calls = [];
  let nextId = 100;
  const worker = createGlobalRaidsWorker({
    store: {
      readGlobalRaids: () => structuredClone(data),
      writeGlobalRaids: (v) => {
        data = structuredClone(v);
      },
    },
    owner: "test",
    now: () => time,
    isClosed: () => false,
    maxMessageLength: 3500,
    chatId: "@raidschannel",
    getBoss: (id) => ({ name: `Босс-${id}`, departmentId: "dept-J1" }),
    telegram: {
      request: async (method, payload) => {
        calls.push({ method, payload });
        return { message_id: ++nextId };
      },
    },
  });
  await worker.tick();
  const count = data.continuations.length;
  assert.ok(count > 0);
  assert.equal(data.continuations[0].messageId, 102);
  time += minute;
  await worker.tick();
  assert.equal(
    calls.filter((call) => call.method === "sendRichMessage").length,
    count + 1,
  );
  const mainEdit = calls.find(
    (call) =>
      call.method === "editMessageText" && call.payload.message_id === 101,
  );
  assert.match(
    mainEdit.payload.rich_message.html,
    /https:\/\/t.me\/raidschannel\/102/,
  );
  assert.equal(
    calls.filter((call) => call.method === "editMessageText").length,
    count + 1,
  );
});

test("all statuses remain visible when the whole summary fits", () => {
  const now = start + 30 * minute;
  const raids = [0, 5, 20].map((age, i) => ({
    bossId: i + 1,
    leaderPlayerId: i + 1,
    count: 10,
    active: age === 0,
    fresh: true,
    lastBattleAt: now - age * minute,
  }));
  const html = formatGlobalRaidSummary(
    { day: "2026-10-29", raids },
    now,
    () => ({ name: "Босс" }),
  );
  assert.match(html, /🔵/);
  assert.match(html, /⚪/);
  assert.match(html, /🟡/);
  assert.doesNotMatch(html, /Ещё рейдов/);
});

test("the summary shows the Moscow update time above the table", () => {
  const now = Date.parse("2026-10-29T19:42:00Z");
  const raids = [
    {
      bossId: 1,
      leaderPlayerId: 1,
      count: 10,
      active: true,
      lastBattleAt: now,
    },
  ];
  const html = formatGlobalRaidSummary(
    { day: "2026-10-29", raids },
    now,
    () => ({ name: "Босс" }),
  );
  assert.match(
    html,
    /^<h3>🔥 Активные рейды • 29\.10\.2026 • 22:42 МСК<\/h3>\n<table/,
  );
  assert.doesNotMatch(html, /Обновлено:/);
});

test("a raid without a leader identifier is skipped instead of showing an unusable placeholder", () => {
  const now = start + minute;
  const raids = [
    { bossId: 1, count: 10, active: true, lastBattleAt: now },
    {
      bossId: 2,
      count: 10,
      active: true,
      lastBattleAt: now,
      leaderPlayerId: 42,
    },
  ];
  const html = formatGlobalRaidSummary(
    { day: "2026-10-29", raids },
    now,
    (id) => ({ name: `Босс-${id}` }),
  );
  assert.doesNotMatch(html, /Босс-1|Ник не найден/);
  assert.match(html, /text="42">ID 42<\/tg-button>/);
  assert.doesNotMatch(html, /Ещё рейдов/);
});

test("nickname fallback uses verified leader identity and escapes text and copy attributes", () => {
  const now = start + 10 * minute;
  const state = {
    day: "2026-10-29",
    observations: {
      another: {
        leaderPlayerId: 42,
        leaderName: 'Игрок "<A&B>"',
        lastSeen: now,
      },
    },
    raids: [
      {
        bossId: 7,
        leaderPlayerId: 42,
        count: 12,
        active: true,
        lastBattleAt: now,
      },
    ],
  };
  const html = formatGlobalRaidSummary(state, now, () => ({ name: "Босс" }));
  assert.match(
    html,
    /<tg-button type="copy_text" text="Игрок &quot;&lt;A&amp;B&gt;&quot;">Игрок "&lt;A&amp;B&gt;"<\/tg-button>/,
  );
  assert.doesNotMatch(html, /<A&B>/);
});

test("resolves an unknown leader by verified profile ID and publishes a copyable nickname", async () => {
  let time = start + 10 * minute;
  let data = await series();
  data.raids[0].count = 12;
  data.raids[0].base = {
    ...data.raids[0],
    count: 12,
    lastBattleAt: time,
    activeIds: [],
  };
  data.raids[0].carried = true;
  let sent;
  const worker = createGlobalRaidsWorker({
    store: {
      readGlobalRaids: () => structuredClone(data),
      writeGlobalRaids: (v) => {
        data = structuredClone(v);
      },
    },
    owner: "test",
    now: () => time,
    isClosed: () => false,
    chatId: "@channel",
    getBoss: () => ({ name: "Босс" }),
    getLeaderProfile: async (id) => ({ playerId: id, nickname: "ИгровойНик" }),
    telegram: {
      request: async (_method, payload) => {
        sent = payload.rich_message.html;
        return { message_id: 1 };
      },
    },
  });
  await worker.tick();
  assert.match(sent, /text="ИгровойНик">ИгровойНик<\/tg-button>/);
  assert.doesNotMatch(sent, /Игрок №42/);
});

test("an unrelated profile cannot supply a leader nickname", async () => {
  const time = start + 10 * minute;
  let data = await series();
  data.raids[0].base = {
    ...data.raids[0],
    count: 12,
    lastBattleAt: time,
    activeIds: [],
  };
  data.raids[0].carried = true;
  let sent;
  const worker = createGlobalRaidsWorker({
    store: {
      readGlobalRaids: () => structuredClone(data),
      writeGlobalRaids: (v) => {
        data = structuredClone(v);
      },
    },
    owner: "test",
    now: () => time,
    isClosed: () => false,
    chatId: "@channel",
    getBoss: () => ({ name: "Босс" }),
    getLeaderProfile: async () => ({ playerId: 99, nickname: "Чужой" }),
    telegram: {
      request: async (_method, payload) => {
        sent = payload.rich_message.html;
        return { message_id: 1 };
      },
    },
  });
  await worker.tick();
  assert.match(sent, /text="42">ID 42<\/tg-button>/);
  assert.doesNotMatch(sent, /Чужой|Игрок №42/);
});
