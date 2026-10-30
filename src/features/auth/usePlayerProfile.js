import { useEffect, useState } from "react";
import {
  readStoredSessionJson,
  peekSessionJson,
  subscribeSessionData,
} from "../../../shared/session-api.js";
import {
  readSession,
  storedSessionIdentity,
  subscribeSession,
} from "../../../shared/auth-session.js";
import {
  normalizeActiveStashBuffs,
  normalizePlayerProfile,
  retainProfileProgress,
  applyWorkFarmEnergy,
} from "./profile.js";
import { workFarm } from "../bosses/BossBattle/boss-battle-session.js";

function playerProfile(data, previous) {
  const normalized = normalizePlayerProfile(data);
  const profile = retainProfileProgress(normalized, previous);
  const bag = peekSessionJson("/api/me/bag", { allowStale: true });
  return {
    ...profile,
    stashBuffs: normalizeActiveStashBuffs(bag),
    stashBuffsStatus: bag ? "ready" : "loading",
  };
}

function livePlayerProfile(data, previous) {
  return playerProfile(data, previous);
}

function cachedState() {
  if (readSession().status !== "ready" && !readSession().wikiSessionReady)
    return { status: "idle", profile: null };
  const data = peekSessionJson("/api/me", { allowStale: true });
  return {
    status: "loading",
    profile: null,
    identity: data ? profileIdentity(data) : null,
  };
}

function profileIdentity(data) {
  const profile = normalizePlayerProfile(data);
  return {
    playerId: profile.playerId,
    name: profile.name,
    avatarUrl: profile.avatarUrl,
    playerLevel: profile.playerLevel,
    experience: profile.experience,
  };
}

export function usePlayerProfile() {
  const [state, setState] = useState(cachedState);

  useEffect(() => {
    let controller;
    const sessionIdentity = () => {
      try {
        return storedSessionIdentity();
      } catch {
        return null;
      }
    };
    let identity = sessionIdentity();
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      const { signal } = controller;
      const session = readSession();
      const currentIdentity = sessionIdentity();
      const changed = identity !== currentIdentity;
      identity = currentIdentity;
      if (session.status !== "ready" && !session.wikiSessionReady) {
        setState({ status: "idle", profile: null });
        return;
      }
      // Clear only for an account change; revalidation keeps the current view.
      if (changed) {
        setState(cachedState());
      }
      try {
        const stored = await readStoredSessionJson("/api/me", { signal });
        if (signal.aborted) return;
        if (stored.presence === "unknown") {
          setState({
            status: "error",
            profile: null,
            message:
              "Данные профиля ещё не получены. Обновите их после подключения игры.",
          });
          return;
        }
        const data = stored.data;
        setState((current) => ({
          ...current,
          status: "ready",
          identity: profileIdentity(data),
          profile: livePlayerProfile(data, current.profile ?? current.identity),
          levelStatus: Number.isSafeInteger(data.exp?.level)
            ? "ready"
            : "error",
          updatedAt: stored.updatedAt,
          snapshotStatus: stored.snapshotStatus,
          snapshotCompleteness: stored.snapshotCompleteness,
        }));
        try {
          const bag = await readStoredSessionJson("/api/me/bag", { signal });
          if (!signal.aborted)
            setState((current) => ({
              ...current,
              profile: current.profile && {
                ...current.profile,
                stashBuffs:
                  bag.presence === "present"
                    ? normalizeActiveStashBuffs(bag.data)
                    : [],
                stashBuffsStatus:
                  bag.presence === "present" ? "ready" : "error",
              },
            }));
        } catch {
          if (!signal.aborted)
            setState((current) => ({
              ...current,
              profile: current.profile && {
                ...current.profile,
                stashBuffsStatus: current.profile.stashBuffs?.length
                  ? "ready"
                  : "error",
              },
            }));
        }
      } catch (error) {
        const saved = peekSessionJson("/api/me", { allowStale: true });
        if (!signal.aborted)
          setState((current) =>
            current.profile
              ? current
              : saved && saved.playerId === current.identity?.playerId
                ? {
                    ...current,
                    status: "ready",
                    profile: playerProfile(saved, null),
                    levelStatus: "error",
                  }
                : {
                    status: "error",
                    profile: null,
                    identity: current.identity,
                    message:
                      error?.message === "Требуется вход"
                        ? "Войдите в игровой аккаунт, чтобы загрузить профиль."
                        : "Не удалось загрузить профиль игрока.",
                  },
          );
      }
    };
    const unsubscribeData = subscribeSessionData(
      (event) => {
        if (event.cleared) {
          setState(cachedState());
        } else if (event.path === "/api/me") {
          setState((current) => ({
            ...current,
            status: "ready",
            identity: profileIdentity(event.data),
            profile: livePlayerProfile(
              event.data,
              current.profile ?? current.identity,
            ),
            updatedAt: event.updatedAt ?? current.updatedAt,
            snapshotStatus: event.snapshotStatus ?? current.snapshotStatus,
            snapshotCompleteness:
              event.snapshotCompleteness ?? current.snapshotCompleteness,
          }));
        } else if (event.path === "/api/me/bag") {
          setState((current) => ({
            ...current,
            profile: current.profile && {
              ...current.profile,
              stashBuffs: normalizeActiveStashBuffs(event.data),
              stashBuffsStatus: "ready",
            },
          }));
        }
      },
      { resources: ["/api/me", "/api/me/bag"] },
    );
    const unsubscribeWork = workFarm.subscribe(() => {
      if (sessionIdentity() !== identity) return;
      const view = workFarm.getSnapshot().view;
      setState((current) => {
        const profile = applyWorkFarmEnergy(current.profile, view);
        return profile === current.profile ? current : { ...current, profile };
      });
    });
    void load();
    const unsubscribe = subscribeSession(load);
    return () => {
      controller?.abort();
      unsubscribe();
      unsubscribeData();
      unsubscribeWork();
    };
  }, []);

  return state;
}
