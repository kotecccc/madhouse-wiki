import test from "node:test";
import assert from "node:assert/strict";
import { hasPage, pushPage, removePage } from "./page-history.js";

test("nested pages retain their parent and can be removed independently", () => {
  const history = {
    state: { existing: "value" },
    pushState(state) {
      this.state = state;
    },
    replaceState(state) {
      this.state = state;
    },
  };
  const first = pushPage(history);
  const parentState = history.state;
  const second = pushPage(history);
  assert.equal(hasPage(history.state, first), true);
  assert.equal(hasPage(history.state, second), true);
  assert.equal(hasPage(parentState, second), false);
  removePage(history, second);
  assert.equal(hasPage(history.state, first), true);
  assert.equal(hasPage(history.state, second), false);
  assert.equal(history.state.existing, "value");
});

test("a directly opened page gets a home entry and forward navigation reuses its entry", () => {
  const entries = [];
  const history = {
    state: null,
    replaceState(state, unused, url) {
      this.state = state;
      entries.push(["replace", url]);
    },
    pushState(state, unused, url) {
      this.state = state;
      entries.push(["push", url]);
    },
  };
  const location = { pathname: "/boss/29", search: "?source=test", hash: "" };
  const id = pushPage(history, "/boss/29", location);
  assert.deepEqual(entries, [
    ["replace", "/?source=test"],
    ["push", "/boss/29?source=test"],
  ]);
  assert.equal(pushPage(history, "/boss/29", location), id);
  assert.equal(entries.length, 2);
});
