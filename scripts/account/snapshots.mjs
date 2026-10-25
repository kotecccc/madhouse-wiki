import { createHash } from "node:crypto";

// Bounded, demand-driven personal sections. Battle state is deliberately live-only:
// stale battle reads must never become inputs to an automated mutation.
export function isSnapshotPath(path) {
  return /^\/api\/(?:me(?:\/bag)?|floors(?:\/[A-Za-z0-9_-]+\/info)?|rooms|clothing|ornaments\/zones\/\d+|(?:weapons|pets|businesses|bosses)\/\d+)$/.test(
    path,
  );
}
const hash = (value) => createHash("sha256").update(value).digest("hex");
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_SECTIONS = 128;
const secret =
  /token|jwt|authorization|password|session|credential|initdata|secret/i;
function sanitize(value, depth = 0) {
  if (depth > 32) throw new Error("snapshot_depth_exceeded");
  if (Array.isArray(value))
    return value.map((item) => sanitize(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !secret.test(key) &&
            !["__proto__", "constructor", "prototype"].includes(key),
        )
        .map(([key, item]) => [key, sanitize(item, depth + 1)]),
    );
  return value;
}
// A sparse object cannot erase previously known fields. Empty successful lists
// are authoritative; malformed/error envelopes are never successful sections.
function merge(previous, next) {
  if (
    !previous ||
    typeof previous !== "object" ||
    Array.isArray(previous) ||
    Array.isArray(next) ||
    typeof next !== "object" ||
    next === null
  )
    return next;
  const result = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    if (key === "activeBossBattle" && value === null) result[key] = null;
    else if (value !== null && value !== undefined)
      result[key] = merge(previous[key], value);
  }
  return result;
}
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
      ...headers,
    },
  });
export function createAccountSnapshots({
  store,
  fetcher = fetch,
  now = Date.now,
  ttl = 180000,
  cooldown = 30000,
}) {
  const accounts = new Map();
  const credentials = new Map();
  const pending = new Map();
  const reads = new Map();
  for (const record of store.readSnapshots()) {
    if (record.schemaVersion !== 1) continue;
    accounts.set(record.playerId, record);
    for (const digest of record.credentialHashes || [])
      credentials.set(digest, record.playerId);
  }
  // Existing verified automation credentials can read the same account after a
  // restart, even before the first snapshot migration has happened.
  for (const { playerId, value } of store.list()) {
    if (value?.credential) credentials.set(hash(value.credential), playerId);
  }
  const persist = (record) => {
    if (Buffer.byteLength(JSON.stringify(record)) > MAX_BYTES)
      throw new Error("snapshot_capacity_exceeded");
    store.writeSnapshot(record.playerId, record);
    accounts.set(record.playerId, record);
  };
  const state = (record) => ({
    status: record?.health?.status || "unknown",
    lastSuccessAt: record?.lastSuccessAt ?? null,
  });
  function withMetadata(response, record, section, stale = false) {
    const headers = new Headers(response.headers);
    headers.set("X-Madhouse-Game-Status", state(record).status);
    if (record?.lastSuccessAt)
      headers.set("X-Madhouse-Last-Success", String(record.lastSuccessAt));
    if (section?.updatedAt)
      headers.set("X-Madhouse-Section-Updated", String(section.updatedAt));
    headers.set(
      "X-Madhouse-Snapshot",
      !response.ok ? "none" : stale ? "stale" : "current",
    );
    return new Response(response.body, { status: response.status, headers });
  }
  async function upstream(url, init) {
    try {
      return await fetcher(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      return json({ error: "game_unavailable" }, 503);
    }
  }
  function mark(record, status, path = "*") {
    if (!record) return;
    persist({
      ...record,
      health: {
        status,
        checkedAt: now(),
        retryAt: now() + cooldown,
        failedSections: [
          ...new Set([...(record.health?.failedSections || []), path]),
        ].slice(-MAX_SECTIONS),
      },
    });
  }
  async function execute(url, init, { fallback = true, cache = true } = {}) {
    const path = new URL(url).pathname;
    const authorization = new Headers(init.headers).get("authorization");
    if (
      !authorization ||
      authorization.length > 16384 ||
      !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization)
    )
      return json({ error: "game_session_required" }, 401);
    const digest = hash(authorization);
    let playerId = credentials.get(digest);
    let record = playerId ? accounts.get(playerId) : null;
    if (record?.revokedHashes?.includes(digest))
      return withMetadata(
        json({ error: "game_credentials_invalid" }, 401),
        record,
      );
    if (!playerId && path !== "/api/me") {
      const identity = await read("https://cargohustle.online/api/me", {
        headers: { Authorization: authorization },
      });
      if (!identity.ok) return identity;
      playerId = credentials.get(digest);
      record = accounts.get(playerId);
    }
    const key = `${playerId || digest}:${path}:${fallback ? "view" : "live"}`;
    if (pending.has(key)) return (await pending.get(key)).clone();
    const run = async () => {
      record = playerId ? accounts.get(playerId) : null;
      let section = record?.sections?.[path];
      if (
        fallback &&
        record?.health?.status === "unavailable" &&
        record.health.retryAt > now()
      )
        return withMetadata(
          section
            ? json(section.data)
            : json({ error: "snapshot_unknown" }, 503),
          record,
          section,
          true,
        );
      if (
        cache &&
        section &&
        !section.dirty &&
        !record.health?.failedSections?.includes(path) &&
        !(path === "/api/me" && record.health?.failedSections?.includes("*")) &&
        now() - section.updatedAt < ttl
      )
        return withMetadata(json(section.data), record, section);
      const response = await upstream(url, init);
      // Re-read after await so concurrent section updates cannot overwrite one another.
      record = playerId ? accounts.get(playerId) : null;
      section = record?.sections?.[path];
      if (response.status === 401) {
        if (record)
          persist({
            ...record,
            revokedHashes: [
              ...new Set([...(record.revokedHashes || []), digest]),
            ].slice(-8),
            health: { status: "credentials_invalid", checkedAt: now() },
          });
        return withMetadata(
          json({ error: "game_credentials_invalid" }, 401),
          accounts.get(playerId),
        );
      }
      let data;
      if (response.ok) {
        try {
          const reader = response.body?.getReader();
          if (!reader) throw new Error();
          const chunks = [];
          let bytes = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 1024 * 1024) {
              await reader.cancel();
              throw new Error();
            }
            chunks.push(Buffer.from(value));
          }
          const text = Buffer.concat(chunks).toString("utf8");
          data = sanitize(JSON.parse(text));
          if (
            Buffer.byteLength(JSON.stringify(merge(section?.data, data))) >
            1024 * 1024
          )
            throw new Error("snapshot_section_too_large");
          if (
            !data ||
            typeof data !== "object" ||
            (!Array.isArray(data) &&
              (!Object.keys(data).length ||
                data.error ||
                data.partial === true ||
                data.success === false))
          )
            throw new Error();
          if (
            path === "/api/me" &&
            (!Number.isSafeInteger(data.playerId) ||
              data.playerId <= 0 ||
              (playerId && String(data.playerId) !== playerId))
          )
            throw new Error();
        } catch {
          data = undefined;
        }
      }
      if (data !== undefined) {
        if (!playerId) playerId = String(data.playerId);
        record = accounts.get(playerId) || {
          schemaVersion: 1,
          playerId,
          sections: {},
          credentialHashes: [],
        };
        // Bound section count by retaining the most recently used successful data.
        const sections = {
          ...record.sections,
          [path]: {
            data: merge(record.sections[path]?.data, data),
            updatedAt: now(),
          },
        };
        if (Object.keys(sections).length > MAX_SECTIONS) {
          const oldest = Object.keys(sections)
            .filter((key) => key !== "/api/me" && key !== path)
            .sort((a, b) => sections[a].updatedAt - sections[b].updatedAt)[0];
          delete sections[oldest];
        }
        const failedSections = (record.health?.failedSections || []).filter(
          (failed) =>
            failed !== path && !(path === "/api/me" && failed === "*"),
        );
        record = {
          ...record,
          sections,
          credentialHashes: [
            ...new Set([...(record.credentialHashes || []), digest]),
          ].slice(-8),
          lastSuccessAt: now(),
          health: {
            status: failedSections.length ? "unavailable" : "available",
            checkedAt: now(),
            failedSections,
            ...(failedSections.length
              ? { retryAt: record.health?.retryAt || now() }
              : {}),
          },
        };
        while (
          Buffer.byteLength(JSON.stringify(record)) > MAX_BYTES &&
          Object.keys(record.sections).length > 1
        ) {
          const oldest = Object.keys(record.sections)
            .filter((key) => key !== path && key !== "/api/me")
            .sort(
              (a, b) =>
                record.sections[a].updatedAt - record.sections[b].updatedAt,
            )[0];
          delete record.sections[oldest];
        }
        persist(record);
        for (const [known, account] of credentials) {
          if (account === playerId && !record.credentialHashes.includes(known))
            credentials.delete(known);
        }
        credentials.set(digest, playerId);
        return withMetadata(
          json(fallback ? sections[path].data : data),
          record,
          sections[path],
        );
      }
      // Only transient failures use stale data. Other 4xx stay distinct.
      if (response.status === 429 || response.status >= 500 || response.ok) {
        mark(record, "unavailable", path);
        record = accounts.get(playerId);
        return withMetadata(
          fallback && section
            ? json(section.data)
            : json(
                { error: section ? "game_unavailable" : "snapshot_unknown" },
                503,
              ),
          record || { health: { status: "unavailable" } },
          section,
          true,
        );
      }
      return response;
    };
    if (pending.size >= 256)
      return json({ error: "snapshot_read_capacity" }, 503);
    const accountKey = playerId || digest;
    const promise = (reads.get(accountKey) || Promise.resolve()).then(run);
    const tail = promise.catch(() => {});
    reads.set(accountKey, tail);
    pending.set(key, promise);
    try {
      return (await promise).clone();
    } finally {
      pending.delete(key);
      if (reads.get(accountKey) === tail) reads.delete(accountKey);
    }
  }
  const read = (url, init = {}) => execute(url, init);
  async function liveFetch(url, init = {}) {
    const method = (init.method || "GET").toUpperCase();
    const authorization = new Headers(init.headers).get("authorization");
    const playerId = authorization && credentials.get(hash(authorization));
    const record = accounts.get(playerId);
    if (
      method !== "GET" &&
      ["unavailable", "credentials_invalid"].includes(record?.health?.status)
    )
      return withMetadata(
        json({ error: "game_unavailable_actions_paused" }, 503),
        record,
      );
    if (
      method === "GET" &&
      isSnapshotPath(new URL(url).pathname) &&
      !new URL(url).search
    )
      return execute(url, init, { fallback: false, cache: false });
    const response = await upstream(url, init);
    if (method !== "GET" && record) {
      const current = accounts.get(playerId);
      persist({
        ...current,
        sections: Object.fromEntries(
          Object.entries(current.sections).map(([path, section]) => [
            path,
            { ...section, dirty: true },
          ]),
        ),
      });
    }
    if (response.status === 429 || response.status >= 500)
      mark(accounts.get(playerId), "unavailable");
    return response;
  }
  return {
    health(authorization) {
      const playerId = authorization && credentials.get(hash(authorization));
      return state(accounts.get(playerId));
    },
    read,
    liveFetch,
    async fetch(url, init = {}) {
      if (
        (init.method || "GET").toUpperCase() === "GET" &&
        isSnapshotPath(new URL(url).pathname) &&
        !new URL(url).search
      )
        return read(url, init);
      return liveFetch(url, init);
    },
  };
}
