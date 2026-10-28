import test from "node:test";
import assert from "node:assert/strict";
import {
  closeAllPages,
  getPages,
  registerPage,
  refreshTopPage,
  subscribePages,
} from "./page-context.js";

test("nested pages keep their parents mounted and navigation closes them in reverse order", () => {
  const closed = [];
  let changes = 0;
  const unsubscribe = subscribePages(() => changes++);
  const removeFirst = registerPage("first", () => closed.push("first"));
  const back = () => closed.push("back");
  const removeSecond = registerPage("second", () => closed.push("second"), {
    kind: "boss",
    back,
  });
  assert.deepEqual(
    getPages().map((page) => page.id),
    ["first", "second"],
  );
  assert.equal(getPages().at(-1).kind, "boss");
  assert.equal(getPages().at(-1).back, back);
  closeAllPages();
  assert.deepEqual(closed, ["second", "first"]);
  removeSecond();
  assert.equal(getPages().at(-1).id, "first");
  removeFirst();
  assert.equal(getPages().length, 0);
  assert.equal(changes, 4);
  unsubscribe();
});

test("refresh targets only the top page and falls back when it has no refresh", async () => {
  const calls = [];
  const removeFirst = registerPage("first", () => {}, {
    canRefresh: () => true,
    refresh: async () => calls.push("first"),
  });
  const removeSecond = registerPage("second", () => {}, {
    canRefresh: () => true,
    refresh: async () => calls.push("second"),
  });
  assert.equal(await refreshTopPage(), true);
  assert.deepEqual(calls, ["second"]);
  removeSecond();
  const removeThird = registerPage("third", () => {});
  assert.equal(await refreshTopPage(), false);
  removeThird();
  assert.equal(await refreshTopPage(), true);
  assert.deepEqual(calls, ["second", "first"]);
  removeFirst();
});
