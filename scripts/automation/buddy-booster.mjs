import { randomUUID } from "node:crypto";
import { readRaidFriendStatus } from "./raid-friends.mjs";

const root = "https://cargohustle.online";
const id = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const quantity = (value) => Number.isSafeInteger(value) && value >= 0;

// Read-only discovery is fresh; saved intents never cause a second POST.
export async function tickBuddyBooster({ entry, fetcher, save, now, allowed }) {
  const state = entry.buddyHelp;
  const headers = {
    Authorization: entry.credential,
    Accept: "application/json",
  };
  const read = async (path) => {
    const response = await fetcher(`${root}${path}`, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error("buddy_read_unavailable");
    return response.json();
  };
  const items = [];
  const cursors = new Set();
  let cursor = null;
  let complete = false;
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const incoming = await read(
      `/api/player-interactions/booster-requests/incoming?${params}`,
    );
    if (
      !Array.isArray(incoming?.items) ||
      incoming.success === false ||
      incoming.partial === true ||
      incoming.error ||
      !Object.hasOwn(incoming, "nextCursor")
    )
      throw new Error("buddy_requests_incomplete");
    items.push(...incoming.items);
    const next = incoming.nextCursor;
    if (next == null || next === "") {
      complete = true;
      break;
    }
    if (typeof next !== "string" || cursors.has(next))
      throw new Error("buddy_requests_incomplete");
    cursors.add(next);
    cursor = next;
  }
  if (!complete) throw new Error("buddy_requests_incomplete");
  const markCompleted = (pending) => {
    state.completed = [
      ...(state.completed ?? []).filter(
        (item) =>
          item.expiresAt > now() && item.requestId !== pending.requestId,
      ),
      { requestId: pending.requestId, expiresAt: pending.expiresAt },
    ];
  };
  if (state.pending) {
    const row = items.find(
      (item) => item?.requestId === state.pending.requestId,
    );
    if (
      row &&
      ["fulfilled", "completed"].includes(String(row.status).toLowerCase())
    ) {
      state.log = [
        {
          at: now(),
          playerId: state.pending.playerId,
          type: "booster",
          result: "confirmed",
        },
        ...(state.log ?? []),
      ].slice(0, 30);
      markCompleted(state.pending);
      state.pending = null;
      state.notice = null;
      save(entry);
    } else {
      state.notice =
        "Результат отправки препарата не подтверждён; повтор заблокирован.";
      save(entry);
    }
    return;
  }
  const subscription = entry.raidSubscription.getSnapshot();
  if (
    !subscription.enabled ||
    subscription.mode !== "buddy" ||
    !state.boostersEnabled ||
    !allowed()
  )
    return;
  const order = subscription.friendIds ?? [];
  const activeCompleted = (state.completed ?? []).filter(
    (item) => Number.isFinite(item.expiresAt) && item.expiresAt > now(),
  );
  if (activeCompleted.length >= 1000) return;
  const eligible = items.filter(
    (item) =>
      id(item?.requestId) &&
      !activeCompleted.some((done) => done.requestId === item.requestId) &&
      positive(item.playerId) &&
      order.includes(item.playerId) &&
      String(item.status).toLowerCase() === "pending" &&
      Number.isFinite(Date.parse(item.expiresAtUtc)) &&
      Date.parse(item.expiresAtUtc) > now() &&
      (item.boosterType == null || item.boosterType === "full") &&
      (item.quantity == null || item.quantity === 1),
  );
  eligible.sort(
    (a, b) =>
      order.indexOf(a.playerId) - order.indexOf(b.playerId) ||
      Date.parse(a.expiresAtUtc) - Date.parse(b.expiresAtUtc),
  );
  const request =
    eligible.find((item) => item.playerId !== state.lastBoosterFriendId) ??
    eligible[0];
  if (!request) return;
  const friend = await readRaidFriendStatus({
    fetcher,
    credential: entry.credential,
    playerId: request.playerId,
    includeIncoming: false,
  });
  if (friend !== "friend") return;
  const bag = await read("/api/me/bag");
  const count = bag?.boosters?.full?.count;
  if (
    !quantity(count) ||
    !quantity(state.fullBoosterReserve) ||
    count <= state.fullBoosterReserve
  ) {
    state.notice =
      "Нет подтверждённого запаса полного препарата сверх резерва.";
    save(entry);
    return;
  }
  if (!allowed() || Date.parse(request.expiresAtUtc) <= now()) return;
  const operationId = randomUUID();
  state.lastBoosterFriendId = request.playerId;
  state.pending = {
    requestId: request.requestId,
    playerId: request.playerId,
    operationId,
    expiresAt: Date.parse(request.expiresAtUtc),
  };
  state.notice = "Проверяем отправку препарата.";
  save(entry);
  if (entry.storageFailed) return;
  if (!allowed() || state.pending.expiresAt <= now()) {
    state.pending = null;
    state.notice = null;
    save(entry);
    return;
  }
  const response = await fetcher(
    `${root}/api/player-interactions/booster-requests/${encodeURIComponent(request.requestId)}/fulfill`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ operationId }),
      redirect: "error",
      signal: AbortSignal.timeout(20000),
      canDispatch: () =>
        allowed() &&
        state.pending?.operationId === operationId &&
        state.pending.expiresAt > now() &&
        entry.raidSubscription
          .getSnapshot()
          .friendIds?.includes(request.playerId),
    },
  ).catch((error) => {
    if (
      error.notDispatched &&
      state.pending?.operationId === operationId &&
      !entry.storageFailed
    ) {
      state.pending = null;
      state.notice = null;
      save(entry);
    }
    throw error;
  });
  if (!response.ok) throw new Error("buddy_booster_uncertain");
  const payload = await response.json().catch(() => null);
  if (payload?.success !== true) throw new Error("buddy_booster_uncertain");
  markCompleted(state.pending);
  state.pending = null;
  state.notice = null;
  state.log = [
    {
      at: now(),
      playerId: request.playerId,
      type: "booster",
      result: "confirmed",
    },
    ...(state.log ?? []),
  ].slice(0, 30);
  save(entry);
}
