import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createChannelGameStatusWorker,
  createChannelPublicationTick,
  formatChannelGameStatus,
  channelStatusAt,
  observeChannelStatus,
  statusSectionForPath,
  statusRouteGroup,
} from "./channel-game-status.mjs";

const observe = (state, status, at, routeGroup = "list") =>
  observeChannelStatus(state, { status, at, routeGroup });

test("classifies only known sections without persisting identifiers", () => {
  assert.equal(statusSectionForPath("/api/me"), "authorization");
  assert.equal(statusSectionForPath("/api/clothing/by-category/1"), "weapons");
  assert.equal(statusSectionForPath("/api/bosses/123"), "bosses");
  assert.equal(statusSectionForPath("/api/combat/battles/123"), "pvp");
  assert.equal(statusSectionForPath("/api/not-bosses/123"), null);
  for (const [path, section] of [
    ["/api/floors/A1/info", "floors"],
    ["/api/works/open", "works"],
    ["/api/businesses/1", "businesses"],
    ["/api/clothing", "clothing"],
    ["/api/clothing/by-category/9", "pets"],
    ["/api/rooms", "rooms"],
    ["/api/ornaments/zones/1", "ornaments"],
    ["/api/mutagens/state", "mutagens"],
  ])
    assert.equal(statusSectionForPath(path), section);
  assert.equal(
    statusRouteGroup("/api/bosses/123/battles/secret"),
    "bosses_item_battles_item",
  );
});

test("requires three spaced 500 responses and successful recovery", () => {
  let state = observe({}, 500, 1000);
  state = observe(state, 500, 16000);
  state = observe(state, 500, 31000, "detail");
  assert.equal(channelStatusAt(state, 31000), "failure");
  state = observe(state, 200, 46000);
  assert.equal(channelStatusAt(state, 46000), "failure");
  state = observe(state, 200, 61000);
  assert.equal(channelStatusAt(state, 61000), "failure");
  state = observe(state, 200, 76000, "detail");
  state = observe(state, 200, 91000, "detail");
  assert.equal(channelStatusAt(state, 91000), "success");
  assert.equal(channelStatusAt(state, 691001), "unknown");
  assert.equal(state.confirmed, "success");
});

test("other errors and tightly spaced failures do not confirm", () => {
  let state = observe({}, 500, 1000);
  const before = structuredClone(state);
  for (const code of [401, 403, 429, 501, 502, 503, 504, 599])
    assert.deepEqual(observe(state, code, 2000), before);
  state = observe(state, 500, 2000, "detail");
  state = observe(state, 500, 16000);
  assert.equal(channelStatusAt(state, 16000), "unknown");
  state = observe(state, 500, 31000);
  assert.equal(channelStatusAt(state, 31000), "failure");
});

function harness(initial, send = async () => ({ message_id: 17 })) {
  let time = 1_000;
  let saved = initial || null;
  const calls = [];
  const store = {
    readChannelGameStatus: () => structuredClone(saved),
    writeChannelGameStatus: (state) => {
      saved = structuredClone(state);
    },
  };
  const telegram = {
    request: async (method, payload) => {
      calls.push({ method, payload });
      return send(method, payload);
    },
  };
  const worker = () =>
    createChannelGameStatusWorker({
      store,
      owner: "worker",
      now: () => time,
      telegram,
      chatId: "@test",
    });
  return {
    worker,
    calls,
    advance: (ms) => {
      time += ms;
    },
    state: () => structuredClone(saved),
  };
}

test("publishes a separate emoji-only table, edits it after a confirmed change, and survives restart", async () => {
  const h = harness();
  let w = h.worker();
  await w.tick();
  assert.equal(h.calls[0].method, "sendRichMessage");
  assert.equal(
    (h.calls[0].payload.rich_message.html.match(/<tg-emoji/g) || []).length,
    12,
  );
  assert.match(h.calls[0].payload.rich_message.html, /Авторизация/);
  assert.doesNotMatch(
    h.calls[0].payload.rich_message.html,
    /Нет свежих данных|Ошибки HTTP/,
  );
  w.observe("/api/combat", 500);
  h.advance(15000);
  w.observe("/api/combat", 500);
  h.advance(15000);
  w.observe("/api/combat", 500);
  await w.tick();
  assert.equal(h.calls.length, 1);
  h.advance(90000);
  w = h.worker();
  await w.tick();
  assert.equal(h.calls[1].method, "editMessageText");
  assert.equal(h.calls[1].payload.message_id, 17);
  assert.match(h.calls[1].payload.rich_message.html, /5818665600624365278/);
  await w.tick();
  assert.equal(h.calls.length, 2);
  h.advance(600001);
  await w.tick();
  assert.equal(h.calls.length, 3);
  assert.doesNotMatch(
    h.calls[2].payload.rich_message.html,
    /5818665600624365278/,
  );
});

test("an uncertain send stays blocked across restart and observations", async () => {
  const h = harness(null, async () => {
    throw new Error("connection_lost");
  });
  let w = h.worker();
  await w.tick();
  assert.equal(h.state().pendingSend, true);
  h.advance(120000);
  w = h.worker();
  w.observe("/api/floors", 500);
  await w.tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.state().pendingSend, true);
});

test("a known rejected send retries after the deadline", async () => {
  let tries = 0;
  const h = harness(null, async () => {
    if (++tries === 1)
      throw Object.assign(new Error("flood"), {
        knownRejected: true,
        retryAfterMs: 90000,
      });
    return { message_id: 17 };
  });
  const w = h.worker();
  await w.tick();
  assert.equal(h.state().pendingSend, false);
  h.advance(89999);
  await w.tick();
  assert.equal(tries, 1);
  h.advance(1);
  await w.tick();
  assert.equal(tries, 2);
});

test("old confirmed success does not reappear after one failure", () => {
  let s = observe({}, 200, 1000);
  s = observe(s, 200, 16000);
  s = observe(s, 500, 620001);
  assert.equal(channelStatusAt(s, 620001), "unknown");
  assert.match(
    formatChannelGameStatus(
      { sections: { bosses: { confirmed: "success", confirmedAt: 1000 } } },
      1000,
    ),
    /<tg-emoji emoji-id="5818812952362356039">🟢<\/tg-emoji>/,
  );
});

test("encrypted status and reconciliation survive actual store reopen with worker lease fencing", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createAutomationStateStore } = await import("./state-store.mjs");
  const { reconcilePendingChannelStatus } =
    await import("./reconcile-channel-game-status.mjs");
  const directory = mkdtempSync(join(tmpdir(), "channel-status-"));
  let store = createAutomationStateStore({ directory });
  try {
    assert.equal(store.acquireLease("owner", 1000, 10000), true);
    store.writeChannelGameStatus(
      {
        sections: { bosses: { confirmed: "failure", confirmedAt: 1000 } },
        pendingSend: true,
      },
      "owner",
      1000,
    );
    assert.throws(
      () => store.writeChannelGameStatus({}, "intruder", 1000),
      /automation_worker_unavailable/,
    );
    store.close();
    store = createAutomationStateStore({ directory });
    assert.equal(
      store.readChannelGameStatus().sections.bosses.confirmed,
      "failure",
    );
    reconcilePendingChannelStatus(store, "owner", 1001, 42);
    assert.equal(store.readChannelGameStatus().messageId, 42);
    assert.equal(store.readChannelGameStatus().pendingSend, false);
    assert.throws(
      () => reconcilePendingChannelStatus(store, "owner", 1001, null),
      /no_uncertain/,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("observations arriving while Telegram is sending survive its checkpoint", async () => {
  let finish;
  const h = harness(
    null,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const worker = h.worker();
  const pending = worker.tick();
  await new Promise((resolve) => setImmediate(resolve));
  worker.observe("/api/works/open", 500);
  finish({ message_id: 45 });
  await pending;
  assert.equal(h.state().messageId, 45);
  assert.equal(h.state().sections.works.failure.length, 1);
});

test("unrelated route success cannot confirm recovery", () => {
  let s = observe({}, 500, 1000, "bosses_battles_attack");
  s = observe(s, 500, 16000, "bosses_battles_attack");
  s = observe(s, 500, 31000, "bosses_battles_attack");
  s = observe(s, 200, 46000, "bosses_item");
  s = observe(s, 200, 61000, "bosses_item");
  assert.equal(channelStatusAt(s, 61000), "failure");
});

test("raid and status publishers serialize shared Telegram access and coalesce ticks", async () => {
  const events = [];
  let finish;
  const tick = createChannelPublicationTick({
    raids: {
      tick: () => {
        events.push("raid-start");
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
    status: {
      tick: async () => {
        events.push("status");
      },
    },
  });
  const first = tick();
  await tick();
  assert.deepEqual(events, ["raid-start"]);
  finish();
  await first;
  assert.deepEqual(events, ["raid-start", "status"]);
});

test("automation service persists observations and sends status separately from raids", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createAutomationService } = await import("./service.mjs");
  const { createAutomationStateStore } = await import("./state-store.mjs");
  const directory = mkdtempSync(join(tmpdir(), "channel-status-service-"));
  const store = createAutomationStateStore({ directory });
  const calls = [];
  const telegram = {
    request: async (method, payload) => {
      calls.push({ method, payload });
      return { message_id: calls.length };
    },
  };
  const service = createAutomationService({
    store,
    getBoss: () => ({ name: "Boss" }),
    identifyPlayer: async () => {
      throw new Error("unexpected game request");
    },
    fetcher: async () => {
      throw new Error("unexpected game request");
    },
    globalRaidsTelegram: telegram,
    globalRaidsChatId: "@testchannel",
    globalRaidsCustomEmoji: true,
  });
  try {
    await service.boot();
    service.observeGameResponse("/api/bosses/1", 500);
    assert.equal(
      store.readChannelGameStatus().sections.bosses.failure.length,
      1,
    );
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const sends = calls.filter((call) => call.method === "sendRichMessage");
    assert.equal(sends.length, 2);
    assert.equal(
      sends.filter((call) =>
        call.payload.rich_message.html.includes("Состояние игры"),
      ).length,
      1,
    );
    assert.equal(store.readChannelGameStatus().messageId, 2);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("successes from another route do not hide repeated HTTP 500s", () => {
  let state = observe({}, 500, 1000, "bosses_battles");
  state = observe(state, 200, 5000, "bosses_info");
  state = observe(state, 500, 16000, "bosses_battles");
  state = observe(state, 200, 20000, "bosses_info");
  state = observe(state, 500, 31000, "bosses_battles");
  assert.equal(channelStatusAt(state, 31000), "failure");
});
