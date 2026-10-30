import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAutomationStateStore } from "./state-store.mjs";

// The operator must first inspect the channel; this function does not send anything.
export function reconcilePendingChannelStatus(store, owner, now, messageId) {
  if (
    messageId !== null &&
    (!Number.isSafeInteger(messageId) || messageId <= 0)
  )
    throw new TypeError("message_id_invalid");
  const state = store.readChannelGameStatus();
  if (!state?.pendingSend || state.messageId)
    throw new Error("no_uncertain_channel_status_send");
  state.pendingSend = false;
  state.nextAttemptAt = 0;
  if (messageId !== null) {
    state.messageId = messageId;
    state.lastText = null;
    state.nextEditAt = 0;
  }
  store.writeChannelGameStatus(state, owner, now);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const match = /^--delivered=([1-9]\d*)$/.exec(args[0] || "");
  if (args.length !== 1 || (!match && args[0] !== "--not-delivered"))
    throw new Error(
      "Specify --delivered=TELEGRAM_MESSAGE_ID or --not-delivered after inspecting the channel",
    );
  const messageId = match ? Number(match[1]) : null;
  const directory = process.env.MADHOUSE_AUTOMATION_STATE_DIR;
  if (!directory) throw new Error("MADHOUSE_AUTOMATION_STATE_DIR is required");
  const store = createAutomationStateStore({ directory });
  const owner = `reconcile-${randomUUID()}`;
  const now = Date.now();
  let acquired = false;
  try {
    acquired = store.acquireLease(owner, now, 15000);
    if (!acquired)
      throw new Error("stop the automation worker before reconciliation");
    reconcilePendingChannelStatus(store, owner, now, messageId);
    console.log("Channel status checkpoint reconciled.");
  } finally {
    if (acquired) store.releaseLease(owner);
    store.close();
  }
}
