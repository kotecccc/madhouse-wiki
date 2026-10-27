import { randomUUID } from "node:crypto";
import { readRaidFriendStatus } from "./raid-friends.mjs";
const root = "https://cargohustle.online";
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const quantity = (value) => Number.isSafeInteger(value) && value >= 0;
const key = (playerId, item) =>
  `${playerId}:${item.setId}:${item.ingredientId}`;

// A request has no observed request ID. Once fulfilled, never send the same
// item again until a successful read shows that the request disappeared.
export async function tickBuddyStash({ entry, fetcher, save, now, allowed }) {
  const state = entry.buddyHelp;
  const headers = {
    Authorization: entry.credential,
    Accept: "application/json",
  };
  async function read(playerId) {
    const response = await fetcher(
      `${root}/api/stash/help-requests/${playerId}`,
      { headers, redirect: "error", signal: AbortSignal.timeout(20000) },
    );
    if (!response.ok) throw new Error("buddy_stash_read_unavailable");
    const body = await response.json();
    if (
      !Array.isArray(body?.items) ||
      body.success === false ||
      body.partial === true ||
      body.error ||
      !quantity(body.remainingToday)
    )
      throw new Error("buddy_stash_response_incomplete");
    if (
      !body.items.every(
        (item) => positive(item?.setId) && positive(item?.ingredientId),
      )
    )
      throw new Error("buddy_stash_response_incomplete");
    return body;
  }
  if (state.stashPending) {
    const pending = state.stashPending;
    const response = await read(pending.playerId);
    const stillPresent = response.items.some(
      (item) =>
        item.setId === pending.setId &&
        item.ingredientId === pending.ingredientId,
    );
    state.notice = stillPresent
      ? "Результат отправки заначки не подтверждён; повтор заблокирован."
      : "Просьба о заначке больше не видна, но результат отправки неизвестен; повтор заблокирован.";
    save(entry);
    return;
  }
  const subscription = entry.raidSubscription.getSnapshot();
  if (
    subscription.mode !== "buddy" ||
    !subscription.enabled ||
    !state.stashEnabled ||
    !allowed()
  )
    return;
  const friends = subscription.friendIds ?? [];
  if (!friends.length) return;
  const offset = (state.stashNextIndex ?? 0) % friends.length;
  const playerId = friends[offset];
  state.stashNextIndex = (offset + 1) % friends.length;
  const friend = await readRaidFriendStatus({
    fetcher,
    credential: entry.credential,
    playerId,
    includeIncoming: false,
  });
  if (friend !== "friend") return;
  const response = await read(playerId);
  const observedAt = now();
  const visible = new Set(response.items.map((item) => key(playerId, item)));
  state.stashCompleted = (state.stashCompleted ?? []).filter(
    (item) => item.playerId !== playerId || visible.has(key(playerId, item)),
  );
  if (state.stashCompleted.length >= 1000) {
    save(entry);
    return;
  }
  const item = response.items.find(
    (row) =>
      row.canSend === true &&
      quantity(row.ownedByMe) &&
      quantity(state.stashReserve) &&
      row.ownedByMe > state.stashReserve &&
      !state.stashCompleted.some(
        (old) => key(old.playerId, old) === key(playerId, row),
      ) &&
      !(state.stashBlocked ?? []).some(
        (old) => key(old.playerId, old) === key(playerId, row),
      ),
  );
  if (!item || response.remainingToday === 0 || !allowed()) {
    save(entry);
    return;
  }
  const pending = {
    playerId,
    setId: item.setId,
    ingredientId: item.ingredientId,
    operationId: randomUUID(),
  };
  state.stashPending = pending;
  state.notice = "Проверяем отправку заначки.";
  save(entry);
  if (entry.storageFailed) return;
  if (!allowed() || now() - observedAt > 15000) {
    state.stashPending = null;
    state.notice = null;
    save(entry);
    return;
  }
  const reply = await fetcher(`${root}/api/stash/help-gifts`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      targetPlayerId: playerId,
      items: [{ setId: item.setId, ingredientId: item.ingredientId }],
      operationId: pending.operationId,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    canDispatch: () =>
      allowed() &&
      state.stashPending?.operationId === pending.operationId &&
      now() - observedAt <= 15000 &&
      entry.raidSubscription.getSnapshot().friendIds?.includes(playerId),
  }).catch((error) => {
    if (
      error.notDispatched &&
      state.stashPending?.operationId === pending.operationId &&
      !entry.storageFailed
    ) {
      state.stashPending = null;
      state.notice = null;
      save(entry);
    }
    throw error;
  });
  if (!reply.ok) throw new Error("buddy_stash_uncertain");
  const payload = await reply.json().catch(() => null);
  if (payload?.success !== true) throw new Error("buddy_stash_uncertain");
  state.stashCompleted = [
    ...state.stashCompleted,
    { playerId, setId: item.setId, ingredientId: item.ingredientId },
  ];
  state.stashPending = null;
  state.notice = null;
  state.log = [
    { at: now(), playerId, type: "stash", result: "confirmed" },
    ...(state.log ?? []),
  ].slice(0, 30);
  save(entry);
}
