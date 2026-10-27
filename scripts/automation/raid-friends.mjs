const root = "https://cargohustle.online";
const fail = (status, message) => Object.assign(new Error(message), { status });
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const normalize = (value) =>
  String(value ?? "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase();

// Only an exact, unambiguous game identity is safe to use as the recipient.
export function resolveRaidLeader(body, { playerId, username }) {
  const rows =
    body?.players ??
    body?.results ??
    body?.friends ??
    (body?.player ? [body.player] : null);
  if (!Array.isArray(rows) || body.success === false || body.partial === true)
    throw fail(503, "friend_search_unavailable");
  const name = normalize(username);
  const matches = rows.filter((row) => {
    const id = row?.playerId;
    return (
      positive(id) &&
      (positive(playerId)
        ? id === playerId && (!name || normalize(row.username) === name)
        : name && normalize(row.username) === name)
    );
  });
  if (matches.length !== 1) throw fail(409, "friend_leader_unverified");
  return matches[0].playerId;
}

async function readList(fetcher, headers, path) {
  let cursor = null;
  const ids = new Set();
  const names = new Set();
  let completeNames = true;
  const seen = new Set();
  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const response = await fetcher(`${root}${path}?${query}`, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw fail(503, "friend_status_unavailable");
    const body = await response.json();
    if (
      !Array.isArray(body?.items) ||
      !Object.hasOwn(body, "nextCursor") ||
      body.success === false ||
      body.partial === true ||
      body.error
    )
      throw fail(503, "friend_status_unavailable");
    for (const row of body.items) {
      const id = row?.player?.playerId;
      if (!positive(id)) throw fail(503, "friend_status_unavailable");
      ids.add(id);
      const name = normalize(row.player.username);
      if (name) names.add(name);
      else completeNames = false;
    }
    const next = body.nextCursor;
    if (next == null || next === "") return { ids, names, completeNames };
    if (typeof next !== "string" || seen.has(next))
      throw fail(503, "friend_status_unavailable");
    seen.add(next);
    cursor = next;
  }
  throw fail(503, "friend_status_unavailable");
}

export async function readRaidFriendStatus({
  fetcher,
  credential,
  playerId,
  includeIncoming = true,
}) {
  if (!positive(playerId)) throw fail(400, "invalid_friend_player");
  const headers = { Authorization: credential, Accept: "application/json" };
  const friends = await readList(fetcher, headers, "/api/friends");
  if (friends.ids.has(playerId)) return "friend";
  const outgoing = await readList(
    fetcher,
    headers,
    "/api/friends/requests/outgoing",
  );
  if (outgoing.ids.has(playerId)) return "pending";
  if (!includeIncoming) return "none";
  const incoming = await readList(
    fetcher,
    headers,
    "/api/friends/requests/incoming",
  );
  return incoming.ids.has(playerId) ? "incoming" : "none";
}

export async function checkRaidFriends({ fetcher, credential, targets }) {
  if (!Array.isArray(targets) || targets.length > 100)
    throw fail(400, "invalid_friend_targets");
  const headers = { Authorization: credential, Accept: "application/json" };
  const friends = await readList(fetcher, headers, "/api/friends");
  const outgoing = await readList(
    fetcher,
    headers,
    "/api/friends/requests/outgoing",
  );
  const incoming = await readList(
    fetcher,
    headers,
    "/api/friends/requests/incoming",
  );
  const statuses = {};
  for (const target of targets) {
    const id = target?.playerId;
    const username = normalize(target?.username);
    const key = positive(id)
      ? `id:${id}`
      : /^[a-z0-9_]{1,64}$/.test(username)
        ? `name:${username}`
        : null;
    if (!key) continue;
    const has = (set) =>
      positive(id) ? set.ids.has(id) : set.names.has(username);
    statuses[key] = has(friends)
      ? "friend"
      : has(outgoing)
        ? "pending"
        : has(incoming)
          ? "incoming"
          : positive(id) ||
              (friends.completeNames &&
                outgoing.completeNames &&
                incoming.completeNames)
            ? "none"
            : "unknown";
  }
  return statuses;
}

export async function refreshWatchedRaidFriends({ entry, fetcher, save }) {
  const current = entry.raidFriend;
  const currentId = current.pending?.playerId ?? current.playerId;
  const watched = { ...entry.raidFriendWatch };
  if (["pending", "uncertain"].includes(current.status) && currentId)
    watched[currentId] = current.username;
  const targets = Object.entries(watched).map(([id, username]) => ({
    playerId: Number(id),
    username,
  }));
  if (!targets.length) return;
  const before = JSON.stringify([
    entry.raidFriend,
    entry.raidFriendWatch,
    entry.raidFriendStatuses,
  ]);
  const statuses = await checkRaidFriends({
    fetcher,
    credential: entry.credential,
    targets,
  });
  for (const target of targets) {
    let status = statuses[`id:${target.playerId}`];
    if (
      current.pending?.playerId === target.playerId &&
      !["friend", "pending"].includes(status)
    )
      status = "uncertain";
    else if (
      entry.raidFriendWatch[target.playerId] !== undefined &&
      status === "none"
    )
      status = "pending";
    else if (currentId === target.playerId)
      entry.raidFriend = {
        pending: null,
        playerId: currentId,
        username: current.username,
        status,
      };
    entry.raidFriendStatuses[`id:${target.playerId}`] = status;
    if (target.username)
      entry.raidFriendStatuses[`name:${target.username}`] = status;
    if (status === "pending")
      entry.raidFriendWatch[target.playerId] = target.username;
    else delete entry.raidFriendWatch[target.playerId];
  }
  if (
    before !==
    JSON.stringify([
      entry.raidFriend,
      entry.raidFriendWatch,
      entry.raidFriendStatuses,
    ])
  )
    save(entry);
}

export async function reconcileRaidFriend({ entry, fetcher, save }) {
  const playerId =
    entry.raidFriend?.pending?.playerId ?? entry.raidFriend?.playerId;
  if (!positive(playerId)) throw fail(400, "invalid_friend_player");
  const status = await readRaidFriendStatus({
    fetcher,
    credential: entry.credential,
    playerId,
    includeIncoming: false,
  });
  // Absence from both lists cannot prove a timed-out POST was not delivered.
  if (entry.raidFriend?.pending && status === "none") return "uncertain";
  if (entry.raidFriend?.status === "pending" && status === "none")
    return "pending";
  entry.raidFriend = {
    pending: null,
    playerId,
    username: entry.raidFriend?.username ?? null,
    status,
  };
  save(entry);
  return status;
}

export async function inspectRaidFriend({ entry, args, fetcher }) {
  const playerId = args.playerId;
  const username = String(args.username ?? "").trim();
  if (!positive(playerId) && !/^@?[A-Za-z0-9_]{1,64}$/.test(username))
    throw fail(400, "invalid_friend_player");
  const query = positive(playerId)
    ? String(playerId)
    : `@${normalize(username)}`;
  const headers = {
    Authorization: entry.credential,
    Accept: "application/json",
  };
  const response = await fetcher(
    `${root}/api/friends/search?${new URLSearchParams({ query })}`,
    { headers, redirect: "error", signal: AbortSignal.timeout(20000) },
  );
  if (!response.ok) throw fail(503, "friend_search_unavailable");
  const recipient = resolveRaidLeader(await response.json(), {
    playerId,
    username,
  });
  const status = await readRaidFriendStatus({
    fetcher,
    credential: entry.credential,
    playerId: recipient,
  });
  return { playerId: recipient, username: normalize(username), status };
}

export async function requestRaidFriend({
  entry,
  args,
  commandId,
  fetcher,
  save,
  allowed = () => true,
}) {
  if (entry.raidFriend?.pending) throw fail(409, "friend_request_uncertain");
  if (!allowed()) throw fail(503, "automation_stopped");
  if (
    entry.raidFriend?.status === "pending" &&
    positive(entry.raidFriend.playerId)
  ) {
    entry.raidFriendWatch ??= {};
    if (
      !Object.hasOwn(entry.raidFriendWatch, String(entry.raidFriend.playerId))
    ) {
      entry.raidFriendWatch[entry.raidFriend.playerId] =
        entry.raidFriend.username ?? null;
      save(entry);
      if (entry.storageFailed)
        throw fail(503, "automation_storage_unavailable");
    }
  }
  const playerId = args.playerId;
  const username = String(args.username ?? "").trim();
  if (!positive(playerId) && !/^@?[A-Za-z0-9_]{1,64}$/.test(username))
    throw fail(400, "invalid_friend_player");
  const query = positive(playerId)
    ? String(playerId)
    : `@${normalize(username)}`;
  const headers = {
    Authorization: entry.credential,
    Accept: "application/json",
  };
  const response = await fetcher(
    `${root}/api/friends/search?${new URLSearchParams({ query })}`,
    { headers, redirect: "error", signal: AbortSignal.timeout(20000) },
  );
  if (!response.ok) throw fail(503, "friend_search_unavailable");
  const recipient = resolveRaidLeader(await response.json(), {
    playerId,
    username,
  });
  if (
    Object.hasOwn(entry.raidFriendWatch ?? {}, String(recipient)) ||
    (entry.raidFriend?.playerId === recipient &&
      entry.raidFriend.status === "pending")
  ) {
    entry.raidFriend = {
      pending: null,
      playerId: recipient,
      username: normalize(username) || null,
      status: "pending",
    };
    save(entry);
    return { playerId: recipient, status: "pending" };
  }
  const before = await readRaidFriendStatus({
    fetcher,
    credential: entry.credential,
    playerId: recipient,
  });
  if (before !== "none") {
    entry.raidFriend = {
      pending: null,
      playerId: recipient,
      username: normalize(username) || null,
      status: before,
    };
    save(entry);
    return { playerId: recipient, status: before };
  }
  entry.raidFriend = {
    pending: { id: commandId, playerId: recipient },
    username: normalize(username) || null,
    status: "uncertain",
  };
  save(entry);
  if (entry.storageFailed) throw fail(503, "automation_storage_unavailable");
  if (!allowed()) throw fail(503, "automation_stopped");
  const sent = await fetcher(`${root}/api/friends/requests`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ playerId: recipient }),
    canDispatch: allowed,
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!sent.ok) {
    throw fail(503, "friend_request_failed");
  }
  const after = await readRaidFriendStatus({
    fetcher,
    credential: entry.credential,
    playerId: recipient,
    includeIncoming: false,
  });
  if (after === "none") throw fail(409, "friend_request_unconfirmed");
  entry.raidFriend = {
    pending: null,
    playerId: recipient,
    username: normalize(username) || null,
    status: after,
  };
  save(entry);
  return { playerId: recipient, status: after };
}
