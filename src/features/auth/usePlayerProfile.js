import { useEffect, useState } from "react";
import {
  getSessionJson,
  peekSessionJson,
  subscribeSessionData,
} from "../../../shared/session-api.js";
import { readSession, subscribeSession } from "../../../shared/auth-session.js";
import {
  normalizeActiveStashBuffs,
  normalizePlayerProfile,
  retainProfileProgress,
  applyWorkFarmEnergy,
} from "./profile.js";
import { workFarm } from "../bosses/BossBattle/boss-battle-session.js";

function playerProfile(data, previous) {
  const profile = retainProfileProgress(normalizePlayerProfile(data), previous);
  const session = readSession();
  profile.playerLevel ??= session.playerLevel;
  if (
    !Number.isSafeInteger(profile.experience.current) ||
    !Number.isSafeInteger(profile.experience.toNextLevel)
  )
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
    let identity = readSession().token;
    let workStatus = workFarm.getSnapshot().run?.status;
    const load = async ({ fresh = false } = {}) => {
      controller?.abort();
      controller = new AbortController();
      const { signal } = controller;
      const session = readSession();
      const changed = identity !== session.token;
      identity = session.token;
      if (session.status !== "ready") {
        setState({ status: "idle", profile: null });
        return;
      }
      // Clear only for an account change; revalidation keeps the current view.
      if (changed) setState(cachedState());
      try {
        const data = await getSessionJson("/api/me", { signal, fresh });
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
      if (readSession().token !== identity) return;
      const view = workFarm.getSnapshot().view;
      setState((current) => {
        const profile = applyWorkFarmEnergy(current.profile, view);
        return profile === current.profile ? current : { ...current, profile };
      });
      const status = workFarm.getSnapshot().run?.status;
      const finished = workStatus === "running" && status !== "running";
      workStatus = status;
      if (finished) void load({ fresh: true });
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
