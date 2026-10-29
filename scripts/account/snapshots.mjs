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
const mutationKind = (path) => {
  if (/^\/api\/bosses\/battles\/[^/]+\/attack$/.test(path)) return "battle";
  if (
    ["/api/weapons/buy", "/api/weapons/repair", "/api/weapons/select"].includes(
      path,
    )
  )
    return "weapon";
  if (["/api/pets/buy", "/api/pets/select"].includes(path)) return "pet";
  if (["/api/rooms/buy", "/api/rooms/select"].includes(path)) return "room";
  if (
    ["/api/clothing/items/buy", "/api/clothing/equip"].includes(path) ||
    /^\/api\/clothing\/equip\/[^/]+$/.test(path)
  )
    return "clothing";
  if (
    ["/api/ornaments/elements/buy", "/api/ornaments/equip"].includes(path) ||
    /^\/api\/ornaments\/equip\/[^/]+$/.test(path)
  )
    return "ornament";
  if (
    [
      "/api/me/bag/boosters/buy",
      "/api/me/bag/boosters/use",
      "/api/me/bag/combat-items/buy",
    ].includes(path)
  )
    return "bag";
  return null;
};
const mutationAffectsSection = (kind, section) => {
  if (!kind) return true;
  if (section === "/api/me") return true;
  if (kind === "bag") return section === "/api/me/bag";
  if (kind === "weapon")
    return (
      section === "/api/clothing/by-category/1" ||
      /^\/api\/weapons\/[1-9][0-9]*$/.test(section)
    );
  if (kind === "pet")
    return (
      section === "/api/clothing/by-category/9" ||
      /^\/api\/pets\/[1-9][0-9]*$/.test(section)
    );
  if (kind === "room") return section === "/api/rooms";
  if (kind === "clothing") return section === "/api/clothing";
  if (kind === "ornament") return section.startsWith("/api/ornaments/zones/");
  if (kind === "battle")
    return (
      isInventoryPath(section) || /^\/api\/bosses\/[1-9][0-9]*$/.test(section)
    );
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
function normalizeMergePayload(value) {
  if (Array.isArray(value)) return value.map(normalizeMergePayload);
  if (!value || typeof value !== "object") return value;
  const normalized = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      normalizeMergePayload(item),
    ]),
  );
  if (
    Object.hasOwn(normalized, "activeStashBuffs") &&
    !Object.hasOwn(normalized, "activeStashBuff")
  )
    normalized.activeStashBuff = null;
  else if (
    Object.hasOwn(normalized, "activeStashBuff") &&
    !Object.hasOwn(normalized, "activeStashBuffs")
  )
    normalized.activeStashBuffs = [];
  return normalized;
}
function sameJsonValue(left, right) {
  if (Object.is(left, right)) return true;
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) !== Array.isArray(right)
  )
    return false;
  if (Array.isArray(left))
    return (
      left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index]))
    );
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) && sameJsonValue(left[key], right[key]),
    )
  );
}
// A sparse object cannot erase previously known fields. Empty successful lists
// are authoritative; malformed/error envelopes are never successful sections.
function merge(previous, next, resourcePath, depth = 0) {
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
    else if (
      depth === 0 &&
      key === "activeBattle" &&
      value === null &&
      /^\/api\/bosses\/([1-9][0-9]*)$/.test(resourcePath || "") &&
      next.id === Number(resourcePath.split("/").at(-1))
    )
      result[key] = null;
    else if (value !== null && value !== undefined)
      result[key] = merge(previous[key], value, resourcePath, depth + 1);
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
  const boundSections = (record, retainedPaths) => {
    while (
      Object.keys(record.sections || {}).length > MAX_SECTIONS ||
      (Buffer.byteLength(JSON.stringify(record)) > MAX_BYTES &&
        Object.keys(record.sections || {}).length > 1)
    ) {
      const oldest = Object.keys(record.sections || {})
        .filter((path) => !retainedPaths.has(path))
        .sort(
          (a, b) =>
            record.sections[a].updatedAt - record.sections[b].updatedAt ||
            a.localeCompare(b),
        )[0];
      if (!oldest) break;
      const sections = { ...record.sections };
      delete sections[oldest];
      record = { ...record, sections };
    }
    return record;
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
        signal: init.signal,
        canDispatch: init.canDispatch,
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
    // Boss cards can use a saved tattoo zone, but must not fetch missing zones.
    if (snapshotOnly && path.startsWith("/api/ornaments/zones/"))
      return json({ error: "snapshot_unavailable" }, 404);
    const key = `${playerId || digest}:${path}:${fallback ? "view" : "live"}:${manualRefreshRequested ? "refresh" : "normal"}:${liveProfile ? "strict" : "regular"}`;
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
      const revisionAtDispatch = record?.profileRevision ?? 0;
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
            signal: init.signal,
            canDispatch: init.canDispatch,
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
            Buffer.byteLength(
              JSON.stringify(merge(section?.data, data, path)),
            ) >
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
          const bossDetail = path.match(/^\/api\/bosses\/([1-9][0-9]*)$/);
          if (
            bossDetail &&
            (!Number.isSafeInteger(data.id) ||
              data.id !== Number(bossDetail[1]))
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
        if ((record.profileRevision ?? 0) !== revisionAtDispatch) {
          const previous = record.sections[path];
          return fallback && previous
            ? withMetadata(json(previous.data), record, previous, true)
            : json({ error: "snapshot_superseded" }, 409);
        }
        const previousSection = record.sections[path];
        const mergedData = merge(previousSection?.data, data, path);
        const retainedPreviousData =
          previousSection &&
          !sameJsonValue(mergedData, normalizeMergePayload(data));
        const sections = {
          ...record.sections,
          [path]: {
            data: mergedData,
            updatedAt: retainedPreviousData ? previousSection.updatedAt : now(),
            ...(retainedPreviousData ? { dirty: true } : {}),
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
        record = boundSections(record, new Set([path, "/api/me"]));
        persist(record);
        for (const [known, account] of credentials) {
          if (account === playerId && !record.credentialHashes.includes(known))
            credentials.delete(known);
        }
        credentials.set(digest, playerId);
        const rawResponse = !fallback || liveProfile;
        const responseSection =
          rawResponse && retainedPreviousData
            ? { ...sections[path], updatedAt: now() }
            : sections[path];
        return withMetadata(
          json(fallback && !liveProfile ? sections[path].data : data),
          record,
          responseSection,
          Boolean(fallback && !liveProfile && retainedPreviousData),
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
        remaining.filter(
          (path) =>
            path !== "/api/me" &&
            !path.startsWith("/api/ornaments/zones/") &&
            isSnapshotPath(path),
        ),
      ),
    ];
    for (const path of retryPaths) {
      const result = await execute(
        new URL(path, url),
        {
          method: "GET",
          headers: { Authorization: authorization },
          signal: init.signal,
          canDispatch: init.canDispatch,
        },
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
    let record = accounts.get(playerId);
    if (
      method === "GET" &&
      isSnapshotPath(new URL(url).pathname) &&
      !new URL(url).search
    )
      return execute(url, init, { fallback: false, cache: false });
    const mutating = method !== "GET" && !workRead;
    const isBattleAttack = /^\/api\/bosses\/battles\/[^/]+\/attack$/.test(path);
    const kind = mutationKind(path);
    const revisionBeforeMutation = record?.profileRevision ?? 0;
    const priorInventoryDirty = new Map();
    // Persist the revision barrier before dispatch. A GET already in flight
    // can then never commit over a mutation whose outcome is still unknown.
    if (mutating && record) {
      const sections = { ...record.sections };
      for (const [sectionPath, section] of Object.entries(sections)) {
        if (!mutationAffectsSection(kind, sectionPath)) continue;
        if (isBattleAttack && isInventoryPath(sectionPath))
          priorInventoryDirty.set(
            sectionPath,
            section.inventoryDirty ?? section.dirty ?? false,
          );
        sections[sectionPath] = {
          ...section,
          dirty: true,
          ...(isInventoryPath(sectionPath)
            ? {
                inventoryDirty:
                  !kind ||
                  (section.inventoryDirty ?? section.dirty ?? false) ||
                  inventoryMutationAffects(path, sectionPath, true),
              }
            : {}),
        };
      }
      record = {
        ...record,
        profileRevision: revisionBeforeMutation + 1,
        sections,
      };
      persist(record);
    }
    const response = await upstream(url, init);
    if (mutating && record && isBattleAttack && response.ok) {
      let battleMayHaveFinished = true;
      try {
        const result = await response.clone().json();
        battleMayHaveFinished = !(
          result?.battle?.status === "active" && result?.battleFinished !== true
        );
      } catch {
        // Unknown outcomes may contain rewards; retain the last snapshot but mark it stale.
      }
      const current = accounts.get(playerId);
      if (
        !battleMayHaveFinished &&
        current?.profileRevision === revisionBeforeMutation + 1
      ) {
        const sections = { ...current.sections };
        for (const [sectionPath, dirty] of priorInventoryDirty) {
          const section = sections[sectionPath];
          if (section)
            sections[sectionPath] = { ...section, inventoryDirty: dirty };
        }
        persist({ ...current, sections });
      }
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
    credentialPlayerId(authorization) {
      if (!authorization) return null;
      const digest = hash(authorization);
      const playerId = credentials.get(digest);
      if (accounts.get(playerId)?.revokedHashes?.includes(digest)) return null;
      const value = Number(playerId);
      return Number.isSafeInteger(value) && value > 0 ? value : null;
    },
    credentialCurrent(authorization) {
      if (!authorization || !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization))
        return false;
      const digest = hash(authorization);
      const record = accounts.get(credentials.get(digest));
      if (record?.revokedHashes?.includes(digest)) return false;
      const parts = authorization.slice(7).split(".");
      if (parts.length === 3) {
        try {
          const claims = JSON.parse(
            Buffer.from(parts[1], "base64url").toString("utf8"),
          );
          if (Number.isFinite(claims.exp) && claims.exp * 1000 <= now())
            return false;
        } catch {
          // Unknown credentials must still be verified by the game.
        }
      }
      return true;
    },
    bridgeProfile(authorization) {
      const digest = hash(authorization);
      const playerId = credentials.get(digest);
      const record = accounts.get(playerId);
      const section = record?.sections?.["/api/me"];
      if (!section || record.revokedHashes?.includes(digest)) return null;
      return withMetadata(
        json(section.data),
        record,
        section,
        now() - section.updatedAt >= ttl,
      );
    },
    saveBridgeProfile(authorization, profile) {
      const data = sanitize(profile);
      if (!Number.isSafeInteger(data?.playerId) || data.playerId <= 0)
        throw new Error("invalid_game_identity");
      const digest = hash(authorization);
      const playerId = String(data.playerId);
      const previousPlayer = credentials.get(digest);
      if (previousPlayer && previousPlayer !== playerId)
        throw new Error("game_identity_changed");
      const record = accounts.get(playerId) || {
        schemaVersion: 1,
        playerId,
        sections: {},
        credentialHashes: [],
      };
      let updated = {
        ...record,
        sections: { ...record.sections, "/api/me": { data, updatedAt: now() } },
        credentialHashes: [
          ...new Set([...(record.credentialHashes || []), digest]),
        ].slice(-8),
        revokedHashes: (record.revokedHashes || []).filter(
          (value) => value !== digest,
        ),
        lastSuccessAt: now(),
        health: {
          ...(record.health || {}),
          status: "available",
          checkedAt: now(),
          failedSections: (record.health?.failedSections || []).filter(
            (path) => path !== "/api/me" && path !== "*",
          ),
        },
      };
      updated = boundSections(updated, new Set(["/api/me"]));
      persist(updated);
      credentials.set(digest, playerId);
    },
    routingIdentity(authorization) {
      const identity = this.identity(authorization);
      if (!identity) return null;
      const record = accounts.get(String(identity.playerId));
      const raw = record?.sections?.["/api/me"]?.data?.telegramId;
      const owner =
        typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0
          ? String(raw)
          : typeof raw === "string" &&
              /^[1-9][0-9]{0,15}$/.test(raw) &&
              Number.isSafeInteger(Number(raw))
            ? raw
            : null;
      return { playerId: identity.playerId, ...(owner ? { owner } : {}) };
    },
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
    resolveStoredOwner(authorization, telegramUserId) {
      if (
        typeof authorization !== "string" ||
        !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization) ||
        !/^[1-9][0-9]{0,19}$/.test(telegramUserId || "")
      )
        return null;
      const playerId = credentials.get(hash(authorization));
      const record = accounts.get(playerId);
      const profile = record?.sections?.["/api/me"]?.data;
      const owner = profile?.telegramId;
      const ownerId =
        typeof owner === "number" && Number.isSafeInteger(owner) && owner > 0
          ? String(owner)
          : typeof owner === "string" && /^[1-9][0-9]{0,19}$/.test(owner)
            ? owner
            : null;
      // The connector's verified legacy record binds this exact credential to
      // the Telegram owner; the snapshot index independently binds it to the
      // verified player. A saved owner, when present, must agree as well.
      const id = Number(playerId);
      return record &&
        String(record.playerId) === playerId &&
        Number.isSafeInteger(id) &&
        id > 0 &&
        (!profile || profile.playerId == null || profile.playerId === id) &&
        (owner == null || ownerId === telegramUserId)
        ? id
        : null;
    },
    read,
    readStored(
      url,
      init = {},
      { verifiedWiki = false, verifiedPlayerId } = {},
    ) {
      const authorization = new Headers(init.headers).get("authorization");
      if (!authorization || !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization))
        return json({ error: "game_session_required" }, 401);
      const token = authorization.slice(7);
      const parts = token.split(".");
      if (!verifiedWiki && parts.length === 3) {
        try {
          const claims = JSON.parse(
            Buffer.from(parts[1], "base64url").toString("utf8"),
          );
          if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now())
            return json({ error: "game_credentials_invalid" }, 401);
        } catch {
          return json({ error: "game_credentials_invalid" }, 401);
        }
      }
      const digest = hash(authorization);
      const playerId =
        verifiedWiki &&
        Number.isSafeInteger(verifiedPlayerId) &&
        verifiedPlayerId > 0
          ? String(verifiedPlayerId)
          : credentials.get(digest);
      const record = accounts.get(playerId);
      if (!record)
        return verifiedWiki && playerId
          ? json({ error: "snapshot_unavailable" }, 404)
          : json({ error: "game_identity_unverified" }, 401);
      if (!verifiedWiki && record.revokedHashes?.includes(digest))
        return json({ error: "game_credentials_invalid" }, 401);
      const parsed = new URL(url);
      const section = !parsed.search && record.sections?.[parsed.pathname];
      if (!section) return json({ error: "snapshot_unavailable" }, 404);
      return withMetadata(
        json(section.data),
        record,
        section,
        Boolean(
          section.dirty ||
          now() - section.updatedAt >= ttl ||
          record.health?.failedSections?.includes(parsed.pathname) ||
          (parsed.pathname === "/api/me" &&
            record.health?.failedSections?.includes("*")) ||
          (record.health?.status === "unavailable" &&
            record.health.retryAt > now()),
        ),
      );
    },
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
