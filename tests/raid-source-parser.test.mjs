import test from "node:test";
import assert from "node:assert/strict";
import {
  parseRaidChannelPost,
  raidSourceChannelUsername,
} from "../scripts/telegram/raid-schedule-parser.mjs";
import { createRaidBlobStore } from "../scripts/telegram/raid-blob-store.mjs";

const text = (text) => ({ _: "textPlain", text });
const cell = (value) => ({
  text: typeof value === "string" ? text(value) : value,
});
const post = (rows) => ({
  id: 32,
  isChannelPost: true,
  date: 1793898000,
  richMessage: {
    blocks: [
      {
        _: "pageBlockHeading5",
        text: text("🔥 Активные рейды • 05.11.2026 • 22:00 МСК"),
      },
      {
        _: "pageBlockTable",
        rows: rows.map((cells) => ({ cells: cells.map(cell) })),
      },
    ],
  },
});

test("imports the external channel rich table without inventing schedule fields", () => {
  const parsed = parseRaidChannelPost(
    post([
      ["Зона", "Босс", "Боёв", "Ведущий"],
      [
        "🔵 A1",
        "Освальд",
        "12",
        {
          _: "textButton",
          text: text("@leader"),
          type: { _: "inlineButtonTypeCopyText", text: "@leader" },
        },
      ],
    ]),
  );
  assert.equal(raidSourceChannelUsername(), "madhouse_wiki_raids");
  assert.equal(parsed.sourceUrl, "https://t.me/madhouse_wiki_raids/32");
  assert.equal(parsed.raidDate, "2026-11-05");
  assert.deepEqual(parsed.raids, [
    { zone: "🔵 A1", boss: "Освальд", leader: "@leader", count: "12" },
  ]);
});

test("preserves rich custom emoji alt and supports the scheduled table", () => {
  const parsed = parseRaidChannelPost({
    id: 33,
    isChannelPost: true,
    text: "Рейды — 05.11.2026\nЗона | Время | Клан | Босс | Ведущий | Длительность\nA1 | 23:00 | Клан | Освальд | @leader | 1ч",
  });
  assert.equal(parsed.raids[0].time, "23:00");
  const rich = parseRaidChannelPost(
    post([
      ["Зона", "Босс", "Ведущий"],
      [
        {
          _: "textConcat",
          texts: [{ _: "textCustomEmoji", alt: "🔵" }, text(" A1")],
        },
        "Освальд",
        "Nickname",
      ],
    ]),
  );
  assert.equal(rich.raids[0].zone, "🔵 A1");
  assert.equal(rich.raids[0].leader, "Nickname");
});

test("empty source table clears raids; unrelated posts and invalid dates are ignored", () => {
  assert.deepEqual(
    parseRaidChannelPost(post([["Зона", "Босс", "Ведущий"]])).raids,
    [],
  );
  assert.equal(
    parseRaidChannelPost({
      id: 1,
      isChannelPost: true,
      text: "Статус игры: работает",
    }),
    null,
  );
  assert.equal(
    parseRaidChannelPost({
      id: 1,
      isChannelPost: true,
      text: "Рейды — 31.02.2026\nЗона | Босс | Ведущий\nA1 | Освальд | @leader",
    }),
    null,
  );
  assert.equal(
    parseRaidChannelPost({ ...post([]), isChannelPost: false }),
    null,
  );
});

test("new channel reads and writes a separate store from legacy message IDs", async () => {
  const paths = [];
  const store = createRaidBlobStore({
    getBlob: async (path) => {
      paths.push(path);
      return null;
    },
    putBlob: async (path) => {
      paths.push(path);
    },
  });
  assert.deepEqual(await store.readRecent(), []);
  await store.save(parseRaidChannelPost(post([["Зона", "Босс", "Ведущий"]])));
  assert.ok(paths.length >= 3);
  assert.ok(
    paths.every(
      (path) => path === "madhouse-raids/madhouse_wiki_raids-schedule.json",
    ),
  );
});

test("explicit empty-channel notice replaces an earlier raid table", () => {
  const message = post([]);
  message.richMessage.blocks = [
    message.richMessage.blocks[0],
    { _: "pageBlockParagraph", text: text("Активных рейдов пока нет.") },
  ];
  assert.deepEqual(parseRaidChannelPost(message).raids, []);
});
