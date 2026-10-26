import { useEffect, useState } from "react";
import {
  getSessionJson,
  peekSessionJson,
  subscribeSessionData,
} from "../../../shared/session-api.js";
import {
  authorizeRequest,
  readSession,
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
  const session = readSession();
  const normalized = normalizePlayerProfile(data);
  normalized.playerLevel ??= session.playerLevel;
  if (
    normalized.playerLevel === session.playerLevel &&
    session.experience &&
    (!Number.isSafeInteger(normalized.experience.current) ||
      !Number.isSafeInteger(normalized.experience.toNextLevel))
  )
    normalized.experience = session.experience;
  const profile = retainProfileProgress(normalized, previous);
  if (
    !Number.isSafeInteger(profile.experience.current) ||
    !Number.isSafeInteger(profile.experience.toNextLevel)
  )
    if (profile.playerLevel === session.playerLevel)
      profile.experience = session.experience ?? profile.experience;
  const bag = peekSessionJson("/api/me/bag", { allowStale: true });
  return {
    ...profile,
    stashBuffs: normalizeActiveStashBuffs(bag),
    stashBuffsStatus: bag ? "ready" : "loading",
  };
}

function cachedState() {
  if (readSession().status !== "ready")
    return { status: "idle", profile: null };
  const data = peekSessionJson("/api/me", { allowStale: true });
  return data
    ? { status: "ready", profile: playerProfile(data) }
    : { status: "loading", profile: null };
}

export function usePlayerProfile() {
  const [state, setState] = useState(cachedState);

  useEffect(() => {
    let controller;
    const sessionIdentity = () => {
      try {
        return authorizeRequest({ url: "/api/me" }).headers.Authorization;
      } catch {
        return null;
      }
    };
    let identity = sessionIdentity();
    let workStatus = workFarm.getSnapshot().run?.status;
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      const { signal } = controller;
      const session = readSession();
      const currentIdentity = sessionIdentity();
      const changed = identity !== currentIdentity;
      identity = currentIdentity;
      if (session.status !== "ready") {
        setState({ status: "idle", profile: null });
        return;
      }
      // Clear only for an account change; revalidation keeps the current view.
      if (changed) setState(cachedState());
      try {
        // The public account snapshot can be old even when it is returned with
        // a successful HTTP response. Revalidate it on mount and keep the
        // current profile in state if the live refresh fails.
        const data = await getSessionJson("/api/me", {
          signal,
          fresh: true,
          serverRefresh: "live",
        });
        if (signal.aborted) return;
        setState((current) => ({
          status: "ready",
          profile: playerProfile(data, current.profile),
        }));
        try {
          const bag = await getSessionJson("/api/me/bag", { signal });
          if (!signal.aborted)
            setState((current) => ({
              ...current,
              profile: current.profile && {
                ...current.profile,
                stashBuffs: normalizeActiveStashBuffs(bag),
                stashBuffsStatus: "ready",
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
        if (!signal.aborted)
          setState((current) =>
            current.profile
              ? current
              : {
                  status: "error",
                  profile: null,
                  message:
                    error?.message === "Требуется вход"
                      ? "Войдите в игровой аккаунт, чтобы загрузить профиль."
                      : "Не удалось загрузить профиль игрока.",
                },
          );
      }
    };
    const unsubscribeData = subscribeSessionData((event) => {
      if (event.cleared) {
        setState(cachedState());
      } else if (event.path === "/api/me") {
        setState((current) => ({
          status: "ready",
          profile: playerProfile(event.data, current.profile),
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
    });
    const unsubscribeWork = workFarm.subscribe(() => {
      if (sessionIdentity() !== identity) return;
      const view = workFarm.getSnapshot().view;
      setState((current) => {
        const profile = applyWorkFarmEnergy(current.profile, view);
        return profile === current.profile ? current : { ...current, profile };
      });
      const status = workFarm.getSnapshot().run?.status;
      const finished = workStatus === "running" && status !== "running";
      workStatus = status;
      if (finished) void load();
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
