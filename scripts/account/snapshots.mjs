import {
  GAME_HEALTH_FEATURES,
  featureForGamePath,
  safeFailedFeatures,
  safeSuccessfulFeatures,
} from "../../shared/game-health-features.js";
import { createHash } from "node:crypto";

// Bounded, demand-driven personal sections. Battle state is deliberately live-only:
// stale battle reads must never become inputs to an automated mutation.
export function isSnapshotPath(path) {
  return /^\/api\/(?:me(?:\/bag)?|stash\/sets|floors(?:\/(?:[A-Za-z0-9_-]+|%24|\$)\/info)?|rooms|clothing(?:\/by-category\/[1-9])?|ornaments\/zones\/\d+|(?:weapons|pets|businesses|bosses)\/\d+)$/.test(
    path,
  );
}
const isInventoryPath = (path) =>
  /^\/api\/(?:rooms|clothing(?:\/by-category\/[1-9])?|ornaments\/zones\/\d+)$/.test(
    path,
  );
const inventoryMutationAffects = (mutation, section, battleMayHaveFinished) => {
  if (/^\/api\/bosses\/battles\/[^/]+\/attack$/.test(mutation))
    return battleMayHaveFinished;
  if (/^\/api\/weapons\//.test(mutation))
    return section === "/api/clothing/by-category/1";
  if (/^\/api\/pets\//.test(mutation))
    return section === "/api/clothing/by-category/9";
  if (/^\/api\/rooms\//.test(mutation)) return section === "/api/rooms";
  if (/^\/api\/clothing\//.test(mutation)) return section === "/api/clothing";
  if (/^\/api\/ornaments\//.test(mutation))
    return section.startsWith("/api/ornaments/zones/");
  return false;
};
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
  // Normalize the two bag API shapes before both first-write and update paths.
  if (next && typeof next === "object" && !Array.isArray(next)) {
    if (
      Object.hasOwn(next, "activeStashBuffs") &&
      !Object.hasOwn(next, "activeStashBuff")
    )
      next = { ...next, activeStashBuff: null };
    else if (
      Object.hasOwn(next, "activeStashBuff") &&
      !Object.hasOwn(next, "activeStashBuffs")
    )
      next = { ...next, activeStashBuffs: [] };
  }
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
    if (
      ["activeStashBuff", "activeStashBuffs"].includes(key) &&
      value !== undefined
    )
      result[key] = value;
    else if (
      key === "exp" &&
      Number.isSafeInteger(value?.level) &&
      value.level !== previous.exp?.level
    )
      result[key] = value;
    else if (key === "activeBossBattle" && value === null) result[key] = null;
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
  refreshProfileProgress,
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
  const state = (record) => {
    const failedFeatures = safeFailedFeatures(
      (record?.health?.failedSections || []).map(featureForGamePath),
    );
    const successfulFeatures = safeSuccessfulFeatures(
      Object.entries(record?.sections || {})
        .filter(
          ([path, section]) =>
            !section.dirty &&
            Number.isFinite(section.updatedAt) &&
            now() - section.updatedAt < ttl &&
            !record?.health?.failedSections?.includes(path) &&
            !(
              path === "/api/me" &&
              record?.health?.failedSections?.includes("*")
            ),
        )
        .map(([path]) => featureForGamePath(path)),
      failedFeatures,
    );
    const featureCheckedAt = Object.fromEntries(
      GAME_HEALTH_FEATURES.map((feature) => {
        const sectionTimes = Object.entries(record?.sections || {})
          .filter(([path]) => featureForGamePath(path) === feature)
          .map(([, section]) => section.updatedAt)
          .filter(Number.isFinite);
        const failedTimes = Object.entries(record?.health?.failedAt || {})
          .filter(([path]) => featureForGamePath(path) === feature)
          .map(([, timestamp]) => timestamp)
          .filter(Number.isFinite);
        return [feature, Math.max(0, ...sectionTimes, ...failedTimes) || null];
      }),
    );
    return {
      status: record?.health?.status || "unknown",
      profileRevision: record?.profileRevision ?? 0,
      lastSuccessAt: record?.lastSuccessAt ?? null,
      failedFeatures,
      successfulFeatures,
      featureCheckedAt,
      featureFailedAt: Object.fromEntries(
        GAME_HEALTH_FEATURES.flatMap((feature) => {
          const times = Object.entries(record?.health?.failedAt || {})
            .filter(
              ([path]) =>
                record?.health?.failedSections?.includes(path) &&
                featureForGamePath(path) === feature,
            )
            .map(([, timestamp]) => timestamp)
            .filter(Number.isFinite);
          return times.length ? [[feature, Math.max(...times)]] : [];
        }),
      ),
    };
  };
  function withMetadata(response, record, section, stale = false) {
    const headers = new Headers(response.headers);
    headers.set("X-Madhouse-Game-Status", state(record).status);
    headers.set(
      "X-Madhouse-Feature-Failed-At",
      JSON.stringify(state(record).featureFailedAt),
    );
    headers.set(
      "X-Madhouse-Failed-Features",
      state(record).failedFeatures.join(","),
    );
    headers.set(
      "X-Madhouse-Successful-Features",
      state(record).successfulFeatures.join(","),
    );
    headers.set(
      "X-Madhouse-Feature-Checked-At",
      JSON.stringify(state(record).featureCheckedAt),
    );
    headers.set("X-Madhouse-Snapshot-TTL", String(ttl));
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
      const read = (init.method || "GET").toUpperCase() === "GET";
      const timeout = AbortSignal.timeout(read ? 15000 : 8000);
      return await fetcher(url, {
        ...init,
        redirect: "error",
        signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
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
        failedAt: Object.fromEntries(
          Object.entries({
            ...(record.health?.failedAt || {}),
            [path]: now(),
          }).slice(-MAX_SECTIONS),
        ),
        failedSections: [
          ...new Set([...(record.health?.failedSections || []), path]),
        ].slice(-MAX_SECTIONS),
      },
    });
  }
  async function execute(
    url,
    init,
    { fallback = true, cache = true, forceFailedRefresh = false } = {},
  ) {
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
    const requestHeaders = new Headers(init.headers);
    const manualRefreshRequested =
      path === "/api/me" &&
      (init.method || "GET").toUpperCase() === "GET" &&
      ["1", "live"].includes(requestHeaders.get("X-Madhouse-Snapshot-Refresh"));
    if (record?.revokedHashes?.includes(digest) && !manualRefreshRequested)
      return withMetadata(
        json({ error: "game_credentials_invalid" }, 401),
        record,
      );
    const snapshotOnly = requestHeaders.get("X-Madhouse-Snapshot-Only") === "1";
    const liveProfile =
      requestHeaders.get("X-Madhouse-Snapshot-Refresh") === "live";
    requestHeaders.delete("X-Madhouse-Snapshot-Only");
    requestHeaders.delete("X-Madhouse-Snapshot-Refresh");
    const upstreamInit = { ...init, headers: requestHeaders };
    if (!playerId && path !== "/api/me") {
      const identity = await read("https://cargohustle.online/api/me", {
        headers: { Authorization: authorization },
      });
      if (!identity.ok) return identity;
      playerId = credentials.get(digest);
      record = accounts.get(playerId);
    }
    const savedSection = record?.sections?.[path];
    const manualRefresh = Boolean(manualRefreshRequested && playerId && record);
    if (
      manualRefresh &&
      !liveProfile &&
      !record.revokedHashes?.includes(digest) &&
      Number.isFinite(record.manualHealthRefreshAt) &&
      now() - (record.manualHealthRefreshAt || 0) < 60_000 &&
      savedSection
    )
      return withMetadata(json(savedSection.data), record, savedSection, true);
    if (snapshotOnly && savedSection)
      return withMetadata(
        json(savedSection.data),
        record,
        savedSection,
        Boolean(
          savedSection.dirty ||
          now() - savedSection.updatedAt >= ttl ||
          record?.health?.failedSections?.includes(path) ||
          (path === "/api/me" &&
            record?.health?.failedSections?.includes("*")) ||
          (record?.health?.status === "unavailable" &&
            record.health.retryAt > now()),
        ),
      );
    const key = `${playerId || digest}:${path}:${fallback ? "view" : "live"}`;
    if (pending.has(key)) return (await pending.get(key)).clone();
    const run = async () => {
      record = playerId ? accounts.get(playerId) : null;
      let section = record?.sections?.[path];
      const mayManualRefresh = Boolean(
        manualRefresh &&
        record &&
        (!Number.isFinite(record.manualHealthRefreshAt) ||
          now() - record.manualHealthRefreshAt >= 60_000),
      );
      if (mayManualRefresh) {
        record = { ...record, manualHealthRefreshAt: now() };
        persist(record);
      }
      if (
        fallback &&
        !mayManualRefresh &&
        !forceFailedRefresh &&
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
        !mayManualRefresh &&
        !forceFailedRefresh &&
        section &&
        !section.dirty &&
        !record.health?.failedSections?.includes(path) &&
        !(path === "/api/me" && record.health?.failedSections?.includes("*")) &&
        now() - section.updatedAt < ttl
      )
        return withMetadata(json(section.data), record, section);
      const response = await upstream(url, upstreamInit);
      // Re-read after await so concurrent section updates cannot overwrite one another.
      record = playerId ? accounts.get(playerId) : null;
      section = record?.sections?.[path];
      if (response.status === 401) {
        if (record && path === "/api/me")
          persist({
            ...record,
            revokedHashes: [
              ...new Set([...(record.revokedHashes || []), digest]),
            ].slice(-8),
            health: { status: "credentials_invalid", checkedAt: now() },
          });
        else if (record) {
          // A section endpoint can reject a request for reasons unrelated to
          // the account credential. Confirm identity before deciding whether
          // last-good section data is safe to return.
          const identity = await upstream("https://cargohustle.online/api/me", {
            headers: { Authorization: authorization },
          });
          let identityData;
          if (identity.ok) {
            try {
              identityData = sanitize(await identity.json());
            } catch {
              identityData = undefined;
            }
          }
          if (
            identity.status === 401 ||
            (identity.ok && identityData?.playerId !== Number(playerId))
          ) {
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
          if (identity.ok && Number.isSafeInteger(identityData?.playerId)) {
            mark(record, "unavailable", path);
            record = accounts.get(playerId);
            return withMetadata(
              fallback && section
                ? json(section.data)
                : json({ error: "game_unavailable" }, 503),
              record,
              section,
              true,
            );
          }
          mark(record, "unavailable", path);
          return withMetadata(
            json({ error: "game_unavailable" }, 503),
            accounts.get(playerId),
            section,
            true,
          );
        }
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
        if (path === "/api/me" && liveProfile && refreshProfileProgress)
          data = await refreshProfileProgress(data, authorization);
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
        const oldLevel = record.sections["/api/me"]?.data?.exp?.level;
        const newLevel = data?.exp?.level;
        if (
          path === "/api/me" &&
          Number.isSafeInteger(oldLevel) &&
          Number.isSafeInteger(newLevel) &&
          oldLevel !== newLevel
        ) {
          for (const [key, section] of Object.entries(sections))
            if (isInventoryPath(key))
              sections[key] = { ...section, dirty: true, inventoryDirty: true };
        }
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
          revokedHashes: (record.revokedHashes || []).filter(
            (revoked) => revoked !== digest,
          ),
          lastSuccessAt: now(),
          health: {
            status: failedSections.length ? "unavailable" : "available",
            checkedAt: now(),
            failedSections,
            failedAt: Object.fromEntries(
              Object.entries(record.health?.failedAt || {}).filter(
                ([failed]) =>
                  failed !== path && !(path === "/api/me" && failed === "*"),
              ),
            ),
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
          json(fallback && !liveProfile ? sections[path].data : data),
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
  async function read(url, init = {}) {
    const requestUrl = new URL(url);
    const headers = new Headers(init.headers);
    const requested =
      requestUrl.pathname === "/api/me" &&
      (init.method || "GET").toUpperCase() === "GET" &&
      ["1", "live"].includes(headers.get("X-Madhouse-Snapshot-Refresh"));
    const authorization = headers.get("authorization");
    if (
      !authorization ||
      authorization.length > 16384 ||
      !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization)
    )
      return execute(url, init);
    const playerId = authorization && credentials.get(hash(authorization));
    let record = accounts.get(playerId);
    if (requested && headers.get("X-Madhouse-Snapshot-Refresh") === "live")
      return execute(url, init, {
        fallback: !record?.revokedHashes?.includes(hash(authorization)),
        cache: false,
        forceFailedRefresh: true,
      });
    if (!requested || !record) return execute(url, init);
    const revoked = record.revokedHashes?.includes(hash(authorization));

    const failed = record.health?.failedSections || [];
    const paths = [
      ...new Set(
        failed.flatMap((path) =>
          path === "*" ? ["/api/me"] : isSnapshotPath(path) ? [path] : [],
        ),
      ),
    ];
    const savedProfile = record.sections?.["/api/me"];
    const needsProfile = paths.includes("/api/me") || !savedProfile;
    if (
      !revoked &&
      !needsProfile &&
      Number.isFinite(record.manualHealthRefreshAt) &&
      now() - record.manualHealthRefreshAt < 60_000
    )
      return withMetadata(json(savedProfile.data), record, savedProfile, true);

    // Explicit profile refresh always validates /api/me first. Sibling section
    // failures are retried only after that identity response is confirmed.
    const response = await execute(
      url,
      init,
      revoked
        ? { fallback: false, cache: false, forceFailedRefresh: true }
        : {},
    );
    if (
      !response.ok ||
      response.headers.get("X-Madhouse-Snapshot") !== "current"
    )
      return response;
    // /api/me was itself failed (or no profile snapshot exists). Recheck its
    // siblings after the profile request has left the per-account queue.
    record = accounts.get(playerId);
    const remaining = record?.health?.failedSections || [];
    const retryPaths = [
      ...new Set(
        remaining.filter((path) => path !== "/api/me" && isSnapshotPath(path)),
      ),
    ];
    for (const path of retryPaths) {
      const result = await execute(
        new URL(path, url),
        { method: "GET", headers: { Authorization: authorization } },
        { fallback: false, cache: false, forceFailedRefresh: true },
      );
      if (result.status === 401) return result;
    }
    const current = accounts.get(playerId);
    return withMetadata(response, current, current?.sections?.["/api/me"]);
  }
  async function liveFetch(url, init = {}) {
    const method = (init.method || "GET").toUpperCase();
    const path = new URL(url).pathname;
    // The game's open endpoint is a state reader using POST transport.
    const workRead = method === "POST" && path === "/api/works/open";
    const authorization = new Headers(init.headers).get("authorization");
    const playerId = authorization && credentials.get(hash(authorization));
    const record = accounts.get(playerId);
    if (
      method === "GET" &&
      isSnapshotPath(new URL(url).pathname) &&
      !new URL(url).search
    )
      return execute(url, init, { fallback: false, cache: false });
    const response = await upstream(url, init);
    if (method !== "GET" && !workRead && record && response.ok) {
      let battleMayHaveFinished = true;
      if (/^\/api\/bosses\/battles\/[^/]+\/attack$/.test(path)) {
        try {
          const result = await response.clone().json();
          battleMayHaveFinished = !(
            result?.battle?.status === "active" &&
            result?.battleFinished !== true
          );
        } catch {
          // Unknown outcomes may contain rewards; retain the last snapshot but mark it stale.
        }
      }
      const current = accounts.get(playerId);
      persist({
        ...current,
        profileRevision: (current.profileRevision ?? 0) + 1,
        sections: Object.fromEntries(
          Object.entries(current.sections).map(([sectionPath, section]) => [
            sectionPath,
            {
              ...section,
              dirty: true,
              ...(isInventoryPath(sectionPath)
                ? {
                    inventoryDirty:
                      (section.inventoryDirty ?? section.dirty ?? false) ||
                      inventoryMutationAffects(
                        path,
                        sectionPath,
                        battleMayHaveFinished,
                      ),
                  }
                : {}),
            },
          ]),
        ),
      });
    }
    const friendList = method === "GET" && path === "/api/friends";
    if (response.status === 429 || response.status >= 500)
      mark(accounts.get(playerId), "unavailable", friendList ? path : "*");
    else if (
      friendList &&
      response.ok &&
      record?.health?.failedSections?.includes(path)
    ) {
      const body = await response
        .clone()
        .json()
        .catch(() => null);
      if (
        Array.isArray(body?.items) &&
        Object.hasOwn(body, "nextCursor") &&
        !body.partial &&
        body.success !== false &&
        !body.error
      ) {
        const current = accounts.get(playerId);
        const failedSections = (current.health?.failedSections || []).filter(
          (failed) => failed !== path,
        );
        persist({
          ...current,
          health: {
            ...current.health,
            status: failedSections.length ? "unavailable" : "available",
            checkedAt: now(),
            failedSections,
            failedAt: Object.fromEntries(
              Object.entries(current.health?.failedAt || {}).filter(
                ([failed]) => failed !== path,
              ),
            ),
          },
        });
      }
    }
    return response;
  }
  return {
    identity(authorization) {
      const playerId = authorization && credentials.get(hash(authorization));
      const record = accounts.get(playerId);
      if (!record || record.revokedHashes?.includes(hash(authorization)))
        return null;
      const data = record.sections?.["/api/me"]?.data;
      if (!data || String(data.playerId) !== playerId) return null;
      return {
        ...Object.fromEntries(
          [
            "playerId",
            "nickname",
            "firstName",
            "username",
            "avatarUrl",
            "photoUrl",
          ]
            .filter((key) => data[key] != null)
            .map((key) => [key, data[key]]),
        ),
        ...(Number.isSafeInteger(data.exp?.level)
          ? {
              exp: Object.fromEntries(
                ["level", "currentExp", "expToNextLevel"]
                  .filter(
                    (key) =>
                      Number.isSafeInteger(data.exp[key]) && data.exp[key] >= 0,
                  )
                  .map((key) => [key, data.exp[key]]),
              ),
            }
          : {}),
      };
    },
    inventory(authorization) {
      const playerId = authorization && credentials.get(hash(authorization));
      const record = accounts.get(playerId);
      if (!record || record.revokedHashes?.includes(hash(authorization)))
        return { sections: {}, dirty: [] };
      const entries = Object.entries(record.sections || {}).filter(([path]) =>
        isInventoryPath(path),
      );
      return {
        sections: Object.fromEntries(
          entries.map(([path, section]) => [path, section.data]),
        ),
        dirty: entries
          .filter(([, section]) => section.inventoryDirty ?? section.dirty)
          .map(([path]) => path),
      };
    },
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
