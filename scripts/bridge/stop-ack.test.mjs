import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { requestRelayStopAck } from "./stop-ack.mjs";

class Socket extends EventEmitter {
  readyState = 1;
  bridgeStopAck = true;
  close(code, reason) {
    this.sent = { code, reason };
  }
}
const challenge = "1".repeat(32);
test("stop acknowledgement requires capability and an exact challenge on the same socket", async () => {
  const socket = new Socket();
  const result = requestRelayStopAck(socket, { nonce: () => challenge });
  assert.deepEqual(socket.sent, { code: 4001, reason: `stop:${challenge}` });
  assert.equal(
    requestRelayStopAck(socket, { nonce: () => "2".repeat(32) }),
    result,
  );
  socket.emit("close", 4001, Buffer.from(`stop:${challenge}`));
  assert.equal(await result, true);
  const old = new Socket();
  old.bridgeStopAck = false;
  assert.equal(await requestRelayStopAck(old), false);
  assert.equal(old.sent, undefined);
});

test("wrong, missing or lost acknowledgements remain unresolved", async () => {
  const mismatch = new Socket();
  const result = requestRelayStopAck(mismatch, { nonce: () => challenge });
  mismatch.emit("close", 4001, Buffer.from(`stop:${"2".repeat(32)}`));
  assert.equal(await result, false);
  let expire;
  const stalled = new Socket();
  const timed = requestRelayStopAck(stalled, {
    nonce: () => challenge,
    setTimer: (fn) => {
      expire = fn;
      return 1;
    },
    clearTimer: () => {},
  });
  expire();
  assert.equal(await timed, false);
  stalled.emit("close", 4001, Buffer.from(`stop:${challenge}`));
});
