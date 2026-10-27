import test from "node:test";
import assert from "node:assert/strict";
import { observeVisibility } from "./visibility-observer.js";

test("visibility updates follow intersection and ignore callbacks after disconnect", () => {
  let instance;
  class FakeObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      instance = this;
    }
    observe(element) {
      this.element = element;
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  const target = {};
  const changes = [];
  const stop = observeVisibility(
    target,
    (value) => changes.push(value),
    { rootMargin: "100% 0px" },
    FakeObserver,
  );
  assert.equal(instance.element, target);
  assert.equal(instance.options.rootMargin, "100% 0px");
  instance.callback([{ isIntersecting: true }]);
  instance.callback([{ isIntersecting: false }]);
  stop();
  instance.callback([{ isIntersecting: true }]);
  assert.deepEqual(changes, [true, false]);
  assert.equal(instance.disconnected, true);
});

test("visibility observation safely falls back when unavailable", () => {
  let calls = 0;
  const stop = observeVisibility({}, () => calls++, undefined, null);
  stop();
  assert.equal(calls, 0);
});
