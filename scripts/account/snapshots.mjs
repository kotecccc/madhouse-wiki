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
function normalizeObservation(path, value) {
  if (
    path !== "/api/me/bag" ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    return value;
  if (
    Object.hasOwn(value, "activeStashBuffs") &&
    !Object.hasOwn(value, "activeStashBuff")
  )
    return { ...value, activeStashBuff: null };
  if (
    Object.hasOwn(value, "activeStashBuff") &&
    !Object.hasOwn(value, "activeStashBuffs")
  )
    return { ...value, activeStashBuffs: [] };
  return value;
}

// Arrays are atomic resource values. Objects can replace prior observations
// only when all previously observed object fields are still explicitly present.
function containsObservedFields(previous, next, resourcePath) {
  if (previous == null || typeof previous !== "object") return true;
  if (next == null || typeof next !== "object") return false;
  if (Array.isArray(previous) || Array.isArray(next))
    return Array.isArray(previous) && Array.isArray(next);
  return Object.entries(previous).every(([key, value]) => {
    if (!Object.hasOwn(next, key)) return false;
    const nextValue = next[key];
    if (
      (resourcePath === "/api/me/bag" &&
        ["activeStashBuff", "activeStashBuffs"].includes(key)) ||
      (resourcePath === "/api/me" &&
        key === "activeBossBattle" &&
        nextValue === null) ||
      (resourcePath === "/api/me" &&
        key === "exp" &&
        Number.isSafeInteger(nextValue?.level) &&
        nextValue.level !== value?.level) ||
      (key === "activeBattle" &&
        nextValue === null &&
        /^\/api\/bosses\/([1-9][0-9]*)$/.test(resourcePath) &&
        next.id === Number(resourcePath.split("/").at(-1)))
    )
      return true;
    return (
      !value ||
      typeof value !== "object" ||
      nextValue == null ||
      typeof nextValue !== "object" ||
      containsObservedFields(value, nextValue, resourcePath)
    );
  });
}

function projectExplicitResourceFields(previous, path, next) {
  if (!previous || !next || typeof next !== "object" || Array.isArray(next))
    return previous;
  const data = previous.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return previous;
  const fields = [];
  if (path === "/api/me/bag")
    fields.push("activeStashBuff", "activeStashBuffs");
  if (path === "/api/me") {
    fields.push("activeBossBattle");
    if (
      Number.isSafeInteger(next.exp?.level) &&
      next.exp.level !== data.exp?.level
    )
      fields.push("exp");
  }
  const bossDetail = path.match(/^\/api\/bosses\/([1-9][0-9]*)$/);
  if (
    bossDetail &&
    next.id === Number(bossDetail[1]) &&
    next.activeBattle === null
  )
    fields.push("activeBattle");
  const updates = Object.fromEntries(
    fields
      .filter((key) => Object.hasOwn(next, key))
      .map((key) => [key, next[key]]),
  );
  return Object.keys(updates).length
    ? { ...previous, data: { ...data, ...updates } }
    : previous;
}

function observedSection(previous, path, raw, observedAt, source, cooldown) {
  const normalized = normalizeObservation(path, raw);
  const priorObservation = previous?.latestObservation;
  const priorRaw =
    priorObservation?.disposition === "rejected_invalid_or_partial"
      ? undefined
      : priorObservation?.rawIsData
        ? previous.data
        : priorObservation?.raw;
  const replaces =
    !previous ||
    (containsObservedFields(previous.data, normalized, path) &&
      (priorRaw === undefined ||
        containsObservedFields(
          normalizeObservation(path, priorRaw),
          normalized,
          path,
        )));
  const latestObservation = {
    observedAt,
    source,
    completeness: "unknown",
    disposition: replaces ? "accepted" : "retained_previous",
    ...(replaces && JSON.stringify(raw) === JSON.stringify(normalized)
      ? { rawIsData: true }
      : { raw }),
  };
  if (replaces)
    return {
      data: normalized,
      revision: (previous?.revision ?? 0) + 1,
      updatedAt: observedAt,
      dirty: false,
      completeness: "unknown",
      latestObservation,
    };
  return {
    ...projectExplicitResourceFields(previous, path, normalized),
    revision: (previous?.revision ?? 0) + 1,
    dirty: true,
    completeness: "unknown",
    latestObservation,
    revalidateAfter: observedAt + Math.max(1, Math.min(cooldown, 60_000)),
  };
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
  const profileRevisions = new Map();
  const mutationContexts = new WeakMap();
  const bridgeProfileReadSequences = new Map();
  const bridgeProfileReadTickets = new WeakMap();
  const bridgeObservationSequences = new Map();
  const bridgeObservationTickets = new WeakMap();
  for (const record of store.readSnapshots()) {
    if (record.schemaVersion !== 1) continue;
    const sections = Object.fromEntries(
      Object.entries(record.sections || {}).map(([path, section]) => [
        path,
        section.completeness === undefined
          ? {
              ...section,
              dirty: true,
              completeness: "unknown",
              revalidateAfter: now() + Math.max(1, Math.min(cooldown, 60_000)),
            }
          : section,
      ]),
    );
    const loaded = { ...record, sections };
    accounts.set(record.playerId, loaded);
    profileRevisions.set(record.playerId, loaded.profileRevision ?? 0);
    for (const digest of loaded.credentialHashes || [])
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
  function beginMutation(
    authorization,
    method,
    path,
    { verifiedPlayerId } = {},
  ) {
    const normalizedMethod = String(method || "GET").toUpperCase();
    const normalizedPath = new URL(path, "https://cargohustle.online").pathname;
    // /api/works/open is a reader carried over POST transport.
    if (
      normalizedMethod === "GET" ||
      (normalizedMethod === "POST" && normalizedPath === "/api/works/open")
    )
      return null;
    if (
      typeof authorization !== "string" ||
      !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization)
    )
      return null;
    // verifiedPlayerId is only for a server caller that already resolved the
    // bridge account binding; it is never taken from a request payload.
    const authorizationDigest = hash(authorization);
    const indexedPlayerId = credentials.get(authorizationDigest);
    const verifiedId =
      Number.isSafeInteger(verifiedPlayerId) && verifiedPlayerId > 0
        ? String(verifiedPlayerId)
        : null;
    const playerId =
      indexedPlayerId && verifiedId && indexedPlayerId !== verifiedId
        ? null
        : indexedPlayerId || verifiedId;
    const record = accounts.get(playerId);
    const currentProfileRevision = Math.max(
      profileRevisions.get(playerId) ?? 0,
      record?.profileRevision ?? 0,
    );
    const token = Object.freeze({});
    const context = {
      authorizationDigest,
      indexedPlayerId,
      verifiedId,
      identityValid:
        (verifiedPlayerId === undefined || verifiedId !== null) &&
        Boolean(indexedPlayerId || verifiedId),
      playerId,
      hadRecord: Boolean(record),
      initialRevision: currentProfileRevision,
      committed: false,
      revision: null,
      isBattleAttack: /^\/api\/bosses\/battles\/[^/]+\/attack$/.test(
        normalizedPath,
      ),
      kind: mutationKind(normalizedPath),
      path: normalizedPath,
      priorInventoryDirty: new Map(),
    };
    mutationContexts.set(token, context);
    return token;
  }
  function commitMutationBarrier(token) {
    const context = token && mutationContexts.get(token);
    if (!context || context.committed) return false;
    const indexedPlayerId = credentials.get(context.authorizationDigest);
    if (
      !context.identityValid ||
      !context.playerId ||
      (context.indexedPlayerId &&
        indexedPlayerId !== context.indexedPlayerId) ||
      (indexedPlayerId && indexedPlayerId !== context.playerId) ||
      (!indexedPlayerId && !context.verifiedId)
    )
      return false;
    const record = accounts.get(context.playerId);
    const currentProfileRevision = Math.max(
      profileRevisions.get(context.playerId) ?? 0,
      record?.profileRevision ?? 0,
    );
    if (currentProfileRevision !== context.initialRevision) return false;
    if (context.hadRecord && !record) return false;
    if (
      record &&
      context.hadRecord &&
      (record.profileRevision ?? 0) !== context.initialRevision
    )
      return false;
    try {
      if (record) {
        const sections = { ...record.sections };
        for (const [sectionPath, section] of Object.entries(sections)) {
          if (!mutationAffectsSection(context.kind, sectionPath)) continue;
          if (context.isBattleAttack && isInventoryPath(sectionPath))
            context.priorInventoryDirty.set(
              sectionPath,
              section.inventoryDirty ?? section.dirty ?? false,
            );
          sections[sectionPath] = {
            ...section,
            revision: (section.revision ?? 0) + 1,
            dirty: true,
            ...(isInventoryPath(sectionPath)
              ? {
                  inventoryDirty:
                    !context.kind ||
                    (section.inventoryDirty ?? section.dirty ?? false) ||
                    inventoryMutationAffects(context.path, sectionPath, true),
                }
              : {}),
          };
        }
        context.revision = context.initialRevision + 1;
        persist({ ...record, profileRevision: context.revision, sections });
      } else {
        // The verified bridge account may not have written its first profile yet.
        // If a snapshot appeared since begin, the record above is invalidated;
        // if none exists, there is no persisted personal data to fence.
        context.revision = context.initialRevision + 1;
      }
      profileRevisions.set(context.playerId, context.revision);
      bumpBridgeProfileReadSequence(context.playerId);
      context.committed = true;
      return true;
    } catch {
      return false;
    }
  }
  async function settleMutation(token, response) {
    const context = token && mutationContexts.get(token);
    if (
      !context?.committed ||
      !context.isBattleAttack ||
      !context.playerId ||
      !response.ok
    )
      return;
    let battleMayHaveFinished = true;
    try {
      const result = await response.clone().json();
      battleMayHaveFinished = !(
        result?.battle?.status === "active" && result?.battleFinished !== true
      );
    } catch {
      // Unknown outcomes may contain rewards; retain the last snapshot but mark it stale.
    }
    const current = accounts.get(context.playerId);
    if (
      !battleMayHaveFinished &&
      context.revision != null &&
      current?.profileRevision === context.revision
    ) {
      const sections = { ...current.sections };
      for (const [sectionPath, dirty] of context.priorInventoryDirty) {
        const section = sections[sectionPath];
        if (section && section.inventoryDirty !== dirty)
          sections[sectionPath] = {
            ...section,
            revision: (section.revision ?? 0) + 1,
            inventoryDirty: dirty,
          };
      }
      persist({ ...current, sections });
    }
    mutationContexts.delete?.(token);
  }
  function bumpBridgeProfileReadSequence(playerId) {
    const next = (bridgeProfileReadSequences.get(playerId) || 0) + 1;
    bridgeProfileReadSequences.set(playerId, next);
    return next;
  }
  const bridgeObservationSequenceKey = (playerId, path) =>
    JSON.stringify([playerId, path]);
  function bumpBridgeObservationSequence(playerId, path) {
    const key = bridgeObservationSequenceKey(playerId, path);
    const next = (bridgeObservationSequences.get(key) || 0) + 1;
    bridgeObservationSequences.set(key, next);
    return next;
  }
  function saveBridgeProfileForDigest(digest, profile) {
    const data = sanitize(profile);
    if (!Number.isSafeInteger(data?.playerId) || data.playerId <= 0)
      throw new Error("invalid_game_identity");
    const playerId = String(data.playerId);
    const previousPlayer = credentials.get(digest);
    if (previousPlayer && previousPlayer !== playerId)
      throw new Error("game_identity_changed");
    const record = accounts.get(playerId) || {
      schemaVersion: 1,
      playerId,
      sections: {},
      credentialHashes: [],
      profileRevision: profileRevisions.get(playerId) ?? 0,
    };
    const profileRevision = Math.max(
      profileRevisions.get(playerId) ?? 0,
      record.profileRevision ?? 0,
    );
    const retainedAfterMutation =
      profileRevision > (record.profileRevision ?? 0);
    const observedAt = now();
    const profileSection = observedSection(
      record.sections["/api/me"],
      "/api/me",
      data,
      observedAt,
      "bridge",
      cooldown,
    );
    if (
      retainedAfterMutation &&
      record.sections["/api/me"] &&
      profileSection.data === record.sections["/api/me"].data
    )
      profileSection.dirty = true;
    let updated = {
      ...record,
      profileRevision,
      sections: {
        ...record.sections,
        "/api/me": profileSection,
      },
      credentialHashes: [
        ...new Set([...(record.credentialHashes || []), digest]),
      ].slice(-8),
      revokedHashes: (record.revokedHashes || []).filter(
        (value) => value !== digest,
      ),
      lastSuccessAt: observedAt,
      health: {
        ...(record.health || {}),
        status: "available",
        checkedAt: observedAt,
        failedSections: (record.health?.failedSections || []).filter(
          (path) => path !== "/api/me" && path !== "*",
        ),
      },
    };
    updated = boundSections(updated, new Set(["/api/me"]));
    persist(updated);
    credentials.set(digest, playerId);
    profileRevisions.set(playerId, profileRevision);
    bumpBridgeProfileReadSequence(playerId);
  }
  function saveBridgeProfile(authorization, profile) {
    return saveBridgeProfileForDigest(hash(authorization), profile);
  }
  function beginBridgeProfileRead(authorization, { verifiedPlayerId } = {}) {
    if (
      typeof authorization !== "string" ||
      !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization)
    )
      return null;
    const authorizationDigest = hash(authorization);
    const indexedPlayerId = credentials.get(authorizationDigest) || null;
    const verifiedId =
      Number.isSafeInteger(verifiedPlayerId) && verifiedPlayerId > 0
        ? String(verifiedPlayerId)
        : null;
    const playerId =
      indexedPlayerId && verifiedId && indexedPlayerId !== verifiedId
        ? null
        : indexedPlayerId || verifiedId;
    const record = playerId ? accounts.get(playerId) : null;
    const ticket = Object.freeze({});
    const context = {
      authorizationDigest,
      indexedPlayerId,
      verifiedId,
      identityValid:
        (verifiedPlayerId === undefined || verifiedId !== null) &&
        Boolean(indexedPlayerId || verifiedId),
      playerId,
      identityKnown: Boolean(playerId),
      hadRecord: Boolean(record),
      profileRevision: Math.max(
        profileRevisions.get(playerId) ?? 0,
        record?.profileRevision ?? 0,
      ),
      sequence: playerId ? bumpBridgeProfileReadSequence(playerId) : null,
      used: false,
    };
    bridgeProfileReadTickets.set(ticket, context);
    return ticket;
  }
  function commitBridgeProfileRead(ticket, profile) {
    const context = ticket && bridgeProfileReadTickets.get(ticket);
    if (!context) return false;
    if (context.used) {
      const successful = context.successfulCommit;
      if (!successful) return false;
      let serialized;
      try {
        serialized = JSON.stringify(sanitize(profile));
      } catch {
        return false;
      }
      const indexedPlayerId =
        credentials.get(context.authorizationDigest) || null;
      const record = accounts.get(successful.playerId);
      const currentRaw = record?.sections?.["/api/me"]?.latestObservation
        ?.rawIsData
        ? record.sections["/api/me"].data
        : record?.sections?.["/api/me"]?.latestObservation?.raw;
      return Boolean(
        serialized === successful.serialized &&
        indexedPlayerId === successful.playerId &&
        Math.max(
          profileRevisions.get(successful.playerId) ?? 0,
          record?.profileRevision ?? 0,
        ) === successful.profileRevision &&
        bridgeProfileReadSequences.get(successful.playerId) ===
          successful.sequence &&
        record?.sections?.["/api/me"]?.latestObservation?.source === "bridge" &&
        JSON.stringify(currentRaw) === successful.serialized,
      );
    }
    context.used = true;
    const indexedPlayerId =
      credentials.get(context.authorizationDigest) || null;
    if (
      !context.identityValid ||
      !context.identityKnown ||
      !context.playerId ||
      (context.indexedPlayerId &&
        indexedPlayerId !== context.indexedPlayerId) ||
      (indexedPlayerId && indexedPlayerId !== context.playerId) ||
      (!indexedPlayerId && !context.verifiedId)
    )
      return false;
    if (bridgeProfileReadSequences.get(context.playerId) !== context.sequence)
      return false;
    const record = accounts.get(context.playerId);
    const currentProfileRevision = Math.max(
      profileRevisions.get(context.playerId) ?? 0,
      record?.profileRevision ?? 0,
    );
    if (
      (context.hadRecord && !record) ||
      (!context.hadRecord && record) ||
      currentProfileRevision !== context.profileRevision ||
      (record && (record.profileRevision ?? 0) !== context.profileRevision) ||
      record?.revokedHashes?.includes(context.authorizationDigest) ||
      String(profile?.playerId) !== context.playerId
    )
      return false;
    try {
      saveBridgeProfileForDigest(context.authorizationDigest, profile);
      const sanitized = sanitize(profile);
      context.successfulCommit = {
        playerId: context.playerId,
        serialized: JSON.stringify(sanitized),
        profileRevision: Math.max(
          profileRevisions.get(context.playerId) ?? 0,
          accounts.get(context.playerId)?.profileRevision ?? 0,
        ),
        sequence: bridgeProfileReadSequences.get(context.playerId),
      };
      return true;
    } catch {
      return false;
    }
  }
  function beginBridgeObservation(
    authorization,
    path,
    { verifiedPlayerId } = {},
  ) {
    if (
      typeof authorization !== "string" ||
      !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization) ||
      typeof path !== "string"
    )
      return null;
    let parsed;
    try {
      parsed = new URL(path, "https://cargohustle.online");
    } catch {
      return null;
    }
    if (
      parsed.origin !== "https://cargohustle.online" ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname === "/api/me" ||
      !isSnapshotPath(parsed.pathname)
    )
      return null;
    const digest = hash(authorization);
    const indexedPlayerId = credentials.get(digest) || null;
    const verifiedId =
      Number.isSafeInteger(verifiedPlayerId) && verifiedPlayerId > 0
        ? String(verifiedPlayerId)
        : null;
    const playerId =
      indexedPlayerId && verifiedId && indexedPlayerId !== verifiedId
        ? null
        : indexedPlayerId || verifiedId;
    const record = playerId ? accounts.get(playerId) : null;
    const section = record?.sections?.[parsed.pathname];
    const ticket = Object.freeze({});
    const context = {
      digest,
      indexedPlayerId,
      verifiedId,
      identityValid:
        (verifiedPlayerId === undefined || verifiedId !== null) &&
        Boolean(indexedPlayerId || verifiedId),
      playerId,
      path: parsed.pathname,
      hadRecord: Boolean(record),
      hadSection: Boolean(section),
      sectionFingerprint: section ? hash(JSON.stringify(section)) : null,
      profileRevision: Math.max(
        profileRevisions.get(playerId) ?? 0,
        record?.profileRevision ?? 0,
      ),
      sequence: playerId
        ? bumpBridgeObservationSequence(playerId, parsed.pathname)
        : null,
      used: false,
    };
    bridgeObservationTickets.set(ticket, context);
    return ticket;
  }
  function commitBridgeObservation(ticket, body) {
    const context = ticket && bridgeObservationTickets.get(ticket);
    if (!context || context.used) return false;
    context.used = true;
    const indexedPlayerId = credentials.get(context.digest) || null;
    if (
      !context.identityValid ||
      !context.playerId ||
      (context.indexedPlayerId &&
        indexedPlayerId !== context.indexedPlayerId) ||
      (indexedPlayerId && indexedPlayerId !== context.playerId) ||
      (!indexedPlayerId && !context.verifiedId) ||
      bridgeObservationSequences.get(
        bridgeObservationSequenceKey(context.playerId, context.path),
      ) !== context.sequence
    )
      return false;
    const record = accounts.get(context.playerId);
    const profileRevision = Math.max(
      profileRevisions.get(context.playerId) ?? 0,
      record?.profileRevision ?? 0,
    );
    const section = record?.sections?.[context.path];
    if (
      (context.hadRecord && !record) ||
      (!context.hadRecord && record) ||
      (context.hadSection &&
        (!section ||
          hash(JSON.stringify(section)) !== context.sectionFingerprint)) ||
      (!context.hadSection && section) ||
      profileRevision !== context.profileRevision ||
      (record && (record.profileRevision ?? 0) !== context.profileRevision) ||
      record?.revokedHashes?.includes(context.digest)
    )
      return false;

    let sanitized;
    let serialized;
    try {
      sanitized = sanitize(body);
      serialized = JSON.stringify(sanitized);
      if (
        serialized === undefined ||
        Buffer.byteLength(serialized) > 1024 * 1024
      )
        return false;
      if (
        !sanitized ||
        typeof sanitized !== "object" ||
        (!Array.isArray(sanitized) &&
          (!Object.keys(sanitized).length ||
            sanitized.error ||
            sanitized.success === false ||
            sanitized.partial === true))
      )
        return false;
      const bossDetail = context.path.match(/^\/api\/bosses\/([1-9][0-9]*)$/);
      if (
        bossDetail &&
        (!Number.isSafeInteger(sanitized.id) ||
          sanitized.id !== Number(bossDetail[1]))
      )
        return false;
    } catch {
      return false;
    }
    const observedAt = now();
    const previous = section;
    const nextSection = observedSection(
      previous,
      context.path,
      sanitized,
      observedAt,
      "bridge",
      cooldown,
    );
    nextSection.latestObservation.sequence = context.sequence;
    const current = record || {
      schemaVersion: 1,
      playerId: context.playerId,
      sections: {},
      credentialHashes: [context.digest],
      profileRevision: context.profileRevision,
    };
    let updated = {
      ...current,
      sections: { ...current.sections, [context.path]: nextSection },
      credentialHashes: [
        ...new Set([...(current.credentialHashes || []), context.digest]),
      ].slice(-8),
    };
    try {
      updated = boundSections(updated, new Set([context.path, "/api/me"]));
      persist(updated);
      credentials.set(context.digest, context.playerId);
      profileRevisions.set(context.playerId, context.profileRevision);
      return true;
    } catch {
      if (!previous) return false;
      try {
        const fallbackRecord = accounts.get(context.playerId) || current;
        const fallbackSection = fallbackRecord.sections[context.path];
        if (!fallbackSection) return false;
        const sections = {
          ...fallbackRecord.sections,
          [context.path]: {
            ...fallbackSection,
            revision: (fallbackSection.revision ?? 0) + 1,
            dirty: true,
            completeness: "unknown",
            latestObservation: {
              observedAt,
              source: "bridge",
              completeness: "unknown",
              sequence: context.sequence,
              rawOmitted: true,
            },
          },
        };
        persist(
          boundSections(
            { ...fallbackRecord, sections },
            new Set([context.path, "/api/me"]),
          ),
        );
        return true;
      } catch {
        return false;
      }
    }
  }
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
  function withMetadata(
    response,
    record,
    section,
    stale = false,
    observationAt = null,
  ) {
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
    if (Number.isFinite(observationAt))
      headers.set("X-Madhouse-Observed-At", String(observationAt));
    if (section?.completeness === "unknown")
      headers.set("X-Madhouse-Snapshot-Completeness", "unknown");
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
    } catch (error) {
      if (
        (init.method || "GET").toUpperCase() !== "GET" &&
        error?.notDispatched === true
      )
        throw error;
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
  // The same eligibility rule is used for direct and bridge display reads.
  // Completeness is reported separately: an incomplete observation can be
  // served until its TTL expires, but is never represented as complete.
  function reusableSection(record, path, section) {
    return Boolean(
      section &&
      !section.dirty &&
      !record?.health?.failedSections?.includes(path) &&
      !(path === "/api/me" && record?.health?.failedSections?.includes("*")) &&
      now() - section.updatedAt < ttl,
    );
  }
  async function execute(
    url,
    init,
    { fallback = true, cache = true, forceFailedRefresh = false } = {},
  ) {
    const requestUrl = new URL(url);
    const path = requestUrl.pathname;
    const queryBearing = Boolean(requestUrl.search);
    const authorization = new Headers(init.headers).get("authorization");
    if (
      !authorization ||
      authorization.length > 16384 ||
      !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization)
    )
      return json({ error: "game_session_required" }, 401);
    const digest = hash(authorization);
    const method = (init.method || "GET").toUpperCase();
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
    const snapshotOnly =
      requestHeaders.get("X-Madhouse-Snapshot-Only") === "1" &&
      !["1", "live"].includes(
        requestHeaders.get("X-Madhouse-Snapshot-Refresh"),
      );
    const liveProfile =
      requestHeaders.get("X-Madhouse-Snapshot-Refresh") === "live";
    requestHeaders.delete("X-Madhouse-Snapshot-Only");
    requestHeaders.delete("X-Madhouse-Snapshot-Refresh");
    const upstreamInit = { ...init, headers: requestHeaders };
    if (snapshotOnly && !liveProfile && !playerId)
      return json({ error: "snapshot_unavailable" }, 404);
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
    if (method === "GET" && playerId && isSnapshotPath(path) && !queryBearing)
      bumpBridgeObservationSequence(playerId, path);
    const savedSection = queryBearing ? null : record?.sections?.[path];
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
    if (snapshotOnly && !liveProfile && savedSection)
      return withMetadata(
        json(savedSection.data),
        record,
        savedSection,
        Boolean(
          savedSection.dirty ||
          savedSection.completeness === "unknown" ||
          now() - savedSection.updatedAt >= ttl ||
          record?.health?.failedSections?.includes(path) ||
          (path === "/api/me" &&
            record?.health?.failedSections?.includes("*")) ||
          (record?.health?.status === "unavailable" &&
            record.health.retryAt > now()),
        ),
      );
    // Snapshot-only is a local display read for every supported resource.
    if (snapshotOnly && !liveProfile)
      return json({ error: "snapshot_unavailable" }, 404);
    const forwardedHeaderFingerprint = hash(
      JSON.stringify(
        [...requestHeaders.entries()]
          .filter(([name]) => name !== "authorization")
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    );
    const key = [
      playerId || digest,
      digest,
      `${requestUrl.origin}${requestUrl.pathname}${requestUrl.search}`,
      forwardedHeaderFingerprint,
      method,
      fallback ? "view" : "live",
      cache ? "cache" : "no-cache",
      forceFailedRefresh ? "force" : "ordinary",
      manualRefreshRequested ? "refresh" : "normal",
      liveProfile ? "strict" : "regular",
      Math.max(
        profileRevisions.get(playerId) ?? 0,
        record?.profileRevision ?? 0,
      ),
    ].join(":");
    // A shared request uses the first caller's Authorization, AbortSignal and
    // dispatch gate. Keep such per-caller control contexts out of dedup, and
    // only coalesce equivalent bodyless GETs with the same credential/options.
    const canShare =
      method === "GET" &&
      init.body == null &&
      init.signal == null &&
      typeof init.canDispatch !== "function";
    if (canShare && pending.has(key)) return (await pending.get(key)).clone();
    const run = async () => {
      record = playerId ? accounts.get(playerId) : null;
      let section = queryBearing ? null : record?.sections?.[path];
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
        !queryBearing &&
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
        !queryBearing &&
        fallback &&
        cache &&
        !mayManualRefresh &&
        !forceFailedRefresh &&
        section?.dirty &&
        Number.isFinite(section.revalidateAfter) &&
        section.revalidateAfter > now()
      )
        return withMetadata(json(section.data), record, section, true);
      if (
        cache &&
        !mayManualRefresh &&
        !forceFailedRefresh &&
        reusableSection(record, path, section)
      )
        return withMetadata(
          json(section.data),
          record,
          section,
          section.completeness === "unknown",
        );
      const dispatchPlayerId = playerId || null;
      const dispatchIdentity = credentials.get(digest) || null;
      const dispatchRecord = dispatchPlayerId
        ? accounts.get(dispatchPlayerId)
        : null;
      const revokedAtDispatch = Boolean(
        dispatchRecord?.revokedHashes?.includes(digest),
      );
      const credentialBindingAtDispatch = hash(
        JSON.stringify({
          credentialHashes: [
            ...(dispatchRecord?.credentialHashes || []),
          ].sort(),
          revokedHashes: [...(dispatchRecord?.revokedHashes || [])].sort(),
        }),
      );
      const sectionAtDispatch = !queryBearing
        ? dispatchRecord?.sections?.[path]
        : null;
      const sectionPresentAtDispatch = Boolean(sectionAtDispatch);
      const sectionFingerprintAtDispatch = sectionAtDispatch
        ? hash(JSON.stringify(sectionAtDispatch))
        : null;
      const revisionAtDispatch = Math.max(
        profileRevisions.get(dispatchPlayerId) ?? 0,
        dispatchRecord?.profileRevision ?? 0,
      );
      const supersessionReason = () => {
        const currentIdentity = credentials.get(digest) || null;
        if (
          currentIdentity !== dispatchIdentity ||
          (currentIdentity && currentIdentity !== dispatchPlayerId)
        )
          return "identity";
        const currentRecord = dispatchPlayerId
          ? accounts.get(dispatchPlayerId)
          : null;
        if (Boolean(currentRecord) !== Boolean(dispatchRecord)) return "record";
        if (
          currentRecord &&
          (String(currentRecord.playerId) !== dispatchPlayerId ||
            Boolean(currentRecord.revokedHashes?.includes(digest)) !==
              revokedAtDispatch ||
            hash(
              JSON.stringify({
                credentialHashes: [
                  ...(currentRecord.credentialHashes || []),
                ].sort(),
                revokedHashes: [...(currentRecord.revokedHashes || [])].sort(),
              }),
            ) !== credentialBindingAtDispatch)
        )
          return "identity";
        const currentRevision = Math.max(
          profileRevisions.get(dispatchPlayerId) ?? 0,
          currentRecord?.profileRevision ?? 0,
        );
        if (currentRevision !== revisionAtDispatch) return "revision";
        if (!queryBearing) {
          const currentSection = currentRecord?.sections?.[path];
          if (Boolean(currentSection) !== sectionPresentAtDispatch)
            return "section";
          if (
            currentSection &&
            hash(JSON.stringify(currentSection)) !==
              sectionFingerprintAtDispatch
          )
            return "section";
        }
        return null;
      };
      const supersededResponse = (reason) => {
        if (reason === "identity")
          return json({ error: "snapshot_superseded" }, 409);
        const currentRecord = dispatchPlayerId
          ? accounts.get(dispatchPlayerId)
          : null;
        const currentSection = !queryBearing
          ? currentRecord?.sections?.[path]
          : null;
        return fallback && currentSection
          ? withMetadata(
              json(currentSection.data),
              currentRecord,
              currentSection,
              true,
            )
          : json({ error: "snapshot_superseded" }, 409);
      };
      const response = await upstream(url, upstreamInit);
      const reasonAfterResponse = supersessionReason();
      if (reasonAfterResponse) return supersededResponse(reasonAfterResponse);
      // Re-read after await so concurrent section updates cannot overwrite one another.
      record = playerId ? accounts.get(playerId) : null;
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
          const reasonAfterIdentityCheck = supersessionReason();
          if (reasonAfterIdentityCheck)
            return supersededResponse(reasonAfterIdentityCheck);
          record = playerId ? accounts.get(playerId) : null;
          section = queryBearing ? null : record?.sections?.[path];
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
      let rejectedObservation;
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
          if (Buffer.byteLength(JSON.stringify(data)) > 1024 * 1024)
            throw new Error("snapshot_section_too_large");
          if (
            !data ||
            typeof data !== "object" ||
            (!Array.isArray(data) &&
              (!Object.keys(data).length ||
                data.error ||
                data.partial === true ||
                data.success === false))
          ) {
            rejectedObservation = data;
            throw new Error();
          }
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
        const rawObservation = data;
        if (path === "/api/me" && liveProfile && refreshProfileProgress)
          data = await refreshProfileProgress(data, authorization);
        if (!playerId) playerId = String(data.playerId);
        const reasonBeforeCommit = supersessionReason();
        if (reasonBeforeCommit) return supersededResponse(reasonBeforeCommit);
        if (dispatchPlayerId === null && accounts.has(String(playerId)))
          return json({ error: "snapshot_superseded" }, 409);
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
        if (queryBearing)
          return withMetadata(json(data), record, undefined, false);
        const previousSection = record.sections[path];
        const observedAt = now();
        const section = observedSection(
          previousSection,
          path,
          rawObservation,
          observedAt,
          "direct",
          cooldown,
        );
        const sections = { ...record.sections, [path]: section };
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
              sections[key] = {
                ...section,
                revision: (section.revision ?? 0) + 1,
                dirty: true,
                inventoryDirty: true,
              };
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
          lastSuccessAt: observedAt,
          health: {
            status: failedSections.length ? "unavailable" : "available",
            checkedAt: observedAt,
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
        bumpBridgeObservationSequence(playerId, path);
        if (path === "/api/me") bumpBridgeProfileReadSequence(playerId);
        const rawResponse = !fallback || liveProfile;
        const responseSection = rawResponse
          ? {
              ...sections[path],
              updatedAt: sections[path].latestObservation.observedAt,
            }
          : sections[path];
        return withMetadata(
          json(fallback && !liveProfile ? sections[path].data : data),
          record,
          responseSection,
          Boolean(
            !rawResponse &&
            (sections[path].dirty || sections[path].completeness === "unknown"),
          ),
          observedAt,
        );
      }
      // Only transient failures use stale data. Other 4xx stay distinct.
      if (
        !queryBearing &&
        (response.status === 429 || response.status >= 500 || response.ok)
      ) {
        const reasonBeforeFailure = supersessionReason();
        if (reasonBeforeFailure) return supersededResponse(reasonBeforeFailure);
        record = playerId ? accounts.get(playerId) : null;
        section = queryBearing ? null : record?.sections?.[path];
        if (response.ok && rejectedObservation && section && record) {
          const observedAt = now();
          const sections = {
            ...record.sections,
            [path]: {
              ...section,
              revision: (section.revision ?? 0) + 1,
              dirty: true,
              completeness: "unknown",
              latestObservation: {
                raw: rejectedObservation,
                observedAt,
                source: "direct",
                completeness: "unknown",
                disposition: "rejected_invalid_or_partial",
              },
              revalidateAfter:
                observedAt + Math.max(1, Math.min(cooldown, 60_000)),
            },
          };
          persist({ ...record, sections });
          record = accounts.get(playerId);
          section = record?.sections?.[path];
        }
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
    const pendingKey = canShare ? key : Symbol("snapshot-read");
    pending.set(pendingKey, promise);
    try {
      return (await promise).clone();
    } finally {
      if (pending.get(pendingKey) === promise) pending.delete(pendingKey);
      if (reads.get(accountKey) === tail) reads.delete(accountKey);
    }
  }
  async function read(url, init = {}) {
    const requestUrl = new URL(url);
    const headers = new Headers(init.headers);
    const refreshMode = headers.get("X-Madhouse-Snapshot-Refresh");
    const requested =
      requestUrl.pathname === "/api/me" &&
      (init.method || "GET").toUpperCase() === "GET" &&
      ["1", "live"].includes(refreshMode);
    const authorization = headers.get("authorization");
    if (
      !authorization ||
      authorization.length > 16384 ||
      !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization)
    )
      return execute(url, init);
    const playerId = authorization && credentials.get(hash(authorization));
    const record = accounts.get(playerId);
    if (
      (init.method || "GET").toUpperCase() === "GET" &&
      isSnapshotPath(requestUrl.pathname) &&
      !requestUrl.search &&
      refreshMode === "live"
    )
      return execute(url, init, {
        fallback: false,
        cache: false,
        forceFailedRefresh: true,
      });
    if (
      !requested &&
      (init.method || "GET").toUpperCase() === "GET" &&
      isSnapshotPath(requestUrl.pathname) &&
      !requestUrl.search &&
      refreshMode === "1"
    )
      return execute(url, init, { cache: false, forceFailedRefresh: true });
    if (!requested || !record) return execute(url, init);
    const revoked = record.revokedHashes?.includes(hash(authorization));
    // A profile refresh does not create demand for unrelated failed sections.
    return execute(
      url,
      init,
      revoked
        ? { fallback: false, cache: false, forceFailedRefresh: true }
        : {},
    );
  }
  async function liveFetch(url, init = {}) {
    const method = (init.method || "GET").toUpperCase();
    const path = new URL(url).pathname;
    // The game's open endpoint is a state reader using POST transport.
    const workRead = method === "POST" && path === "/api/works/open";
    const authorization = new Headers(init.headers).get("authorization");
    const playerId = authorization && credentials.get(hash(authorization));
    if (
      method === "GET" &&
      isSnapshotPath(new URL(url).pathname) &&
      !new URL(url).search
    )
      return execute(url, init, { fallback: false, cache: false });
    const mutating = method !== "GET" && !workRead;
    const mutationTicket = mutating
      ? beginMutation(authorization, method, path)
      : null;
    if (mutating && !commitMutationBarrier(mutationTicket))
      return json({ error: "snapshot_mutation_barrier_unavailable" }, 503);
    const response = await upstream(url, init);
    if (mutationTicket) await settleMutation(mutationTicket, response);
    const record = accounts.get(playerId);
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
    bindVerifiedCredential(authorization, verifiedPlayerId) {
      if (
        typeof authorization !== "string" ||
        !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization) ||
        !Number.isSafeInteger(verifiedPlayerId) ||
        verifiedPlayerId <= 0
      )
        return false;
      const digest = hash(authorization);
      const playerId = String(verifiedPlayerId);
      const indexed = credentials.get(digest);
      const record = accounts.get(playerId);
      if (
        (indexed && indexed !== playerId) ||
        !record ||
        record.revokedHashes?.includes(digest) ||
        String(record.sections?.["/api/me"]?.data?.playerId) !== playerId
      )
        return false;
      if (indexed === playerId) return true;
      const hashes = [
        ...new Set([...(record.credentialHashes || []), digest]),
      ].slice(-8);
      try {
        persist({ ...record, credentialHashes: hashes });
        for (const [known, account] of credentials)
          if (account === playerId && !hashes.includes(known))
            credentials.delete(known);
        credentials.set(digest, playerId);
        return true;
      } catch {
        return false;
      }
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
        Boolean(
          section.dirty ||
          section.completeness === "unknown" ||
          now() - section.updatedAt >= ttl ||
          record.health?.failedSections?.includes("/api/me") ||
          record.health?.failedSections?.includes("*") ||
          (record.health?.status === "unavailable" &&
            record.health.retryAt > now()),
        ),
      );
    },
    saveBridgeProfile,
    beginBridgeProfileRead,
    commitBridgeProfileRead,
    beginBridgeObservation,
    commitBridgeObservation,
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
        return { sections: {}, dirty: [], incomplete: [] };
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
        incomplete: entries
          .filter(([, section]) => section.completeness === "unknown")
          .map(([path]) => path),
      };
    },
    health(authorization) {
      const playerId = authorization && credentials.get(hash(authorization));
      return state(accounts.get(playerId));
    },
    noteReadFailure(authorization, path, { verifiedPlayerId } = {}) {
      const digest = authorization && hash(authorization);
      const indexed = digest && credentials.get(digest);
      const verified =
        Number.isSafeInteger(verifiedPlayerId) && verifiedPlayerId > 0
          ? String(verifiedPlayerId)
          : null;
      if (indexed && verified && indexed !== verified) return false;
      const record = accounts.get(indexed || verified);
      if (
        !record ||
        record.revokedHashes?.includes(digest) ||
        !isSnapshotPath(path)
      )
        return false;
      mark(record, "unavailable", path);
      return true;
    },
    resourceVersions(authorization) {
      const digest = authorization && hash(authorization);
      const record = digest && accounts.get(credentials.get(digest));
      if (!record || record.revokedHashes?.includes(digest)) return null;
      return {
        revision: record.profileRevision ?? 0,
        sections: Object.fromEntries(
          Object.entries(record.sections || {})
            .filter(([path]) => isSnapshotPath(path))
            .map(([path, section]) => [
              path,
              {
                revision: section.revision ?? 0,
                updatedAt: section.updatedAt ?? null,
                dirty: Boolean(section.dirty),
              },
            ]),
        ),
      };
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
    observationVersion(authorization, { verifiedPlayerId, path } = {}) {
      const indexed = credentials.get(hash(authorization || ""));
      const verified =
        Number.isSafeInteger(verifiedPlayerId) && verifiedPlayerId > 0
          ? String(verifiedPlayerId)
          : null;
      if (indexed && verified && indexed !== verified) return null;
      const playerId = indexed || verified;
      if (!playerId) return null;
      const record = accounts.get(playerId);
      return `${playerId}:${Math.max(
        profileRevisions.get(playerId) ?? 0,
        record?.profileRevision ?? 0,
      )}:${record?.sections?.[path]?.revision ?? 0}`;
    },
    observationTime(authorization, path, { verifiedPlayerId } = {}) {
      const indexed = authorization && credentials.get(hash(authorization));
      const verified =
        Number.isSafeInteger(verifiedPlayerId) && verifiedPlayerId > 0
          ? String(verifiedPlayerId)
          : null;
      if (indexed && verified && indexed !== verified) return null;
      const section = accounts.get(indexed || verified)?.sections?.[path];
      return Number.isFinite(section?.latestObservation?.observedAt)
        ? section.latestObservation.observedAt
        : null;
    },
    readDisplayCache(
      url,
      init = {},
      { verifiedPlayerId, verifiedWiki = false } = {},
    ) {
      const parsed = new URL(url);
      if (
        (init.method || "GET").toUpperCase() !== "GET" ||
        parsed.search ||
        !isSnapshotPath(parsed.pathname)
      )
        return null;
      const headers = new Headers(init.headers);
      const refresh = headers.get("X-Madhouse-Snapshot-Refresh");
      if (refresh === "live" || (refresh && parsed.pathname !== "/api/me"))
        return null;
      const authorization = headers.get("authorization");
      const playerId =
        Number.isSafeInteger(verifiedPlayerId) && verifiedPlayerId > 0
          ? String(verifiedPlayerId)
          : credentials.get(hash(authorization || ""));
      const record = accounts.get(playerId);
      const section = record?.sections?.[parsed.pathname];
      if (!section) return null;
      const saved = this.readStored(url, init, {
        verifiedWiki,
        verifiedPlayerId,
      });
      if (!saved.ok) return saved;
      if (refresh === "1") {
        if (
          Number.isFinite(record.manualHealthRefreshAt) &&
          now() - record.manualHealthRefreshAt < 60_000
        ) {
          const responseHeaders = new Headers(saved.headers);
          responseHeaders.set("X-Madhouse-Snapshot", "stale");
          return new Response(saved.body, {
            status: saved.status,
            headers: responseHeaders,
          });
        }
        persist({ ...record, manualHealthRefreshAt: now() });
        return null;
      }
      if (refresh) return null;
      if (
        (record.health?.status === "unavailable" &&
          record.health.retryAt > now()) ||
        (section.dirty &&
          Number.isFinite(section.revalidateAfter) &&
          section.revalidateAfter > now())
      )
        return saved;
      if (
        headers.get("X-Madhouse-Snapshot-Only") === "1" ||
        reusableSection(record, parsed.pathname, section)
      )
        return saved;
      return null;
    },
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
      const indexedPlayerId = credentials.get(digest);
      const verifiedId =
        Number.isSafeInteger(verifiedPlayerId) && verifiedPlayerId > 0
          ? String(verifiedPlayerId)
          : null;
      if (indexedPlayerId && verifiedId && indexedPlayerId !== verifiedId)
        return json({ error: "game_identity_unverified" }, 401);
      const playerId = verifiedId || indexedPlayerId;
      const record = accounts.get(playerId);
      if (!record)
        return (verifiedWiki || verifiedId) && playerId
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
          section.completeness === "unknown" ||
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
    beginMutation,
    commitMutationBarrier,
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
