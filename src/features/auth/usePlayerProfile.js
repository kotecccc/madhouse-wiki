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
    let identity = readSession().identity;
    let workStatus = workFarm.getSnapshot().run?.status;
    let profileRevision = null;
    let profileRefreshTimer = null;
    let profileRefreshRunning = false;
    let profileRefreshQueued = false;
    const refreshChangedProfile = async () => {
      profileRefreshTimer = null;
      if (profileRefreshRunning) {
        profileRefreshQueued = true;
        return;
      }
      if (readSession().identity !== identity || !identity) return;
      profileRefreshRunning = true;
      try {
        await getSessionJson("/api/me", { fresh: true });
      } catch {
        // Keep the last confirmed profile when the game is unavailable.
      } finally {
        profileRefreshRunning = false;
        if (profileRefreshQueued) {
          profileRefreshQueued = false;
          scheduleProfileRefresh();
        }
      }
    };
    const scheduleProfileRefresh = () => {
      if (!profileRefreshTimer)
        profileRefreshTimer = setTimeout(refreshChangedProfile, 2000);
    };
    const onProfileRevision = (event) => {
      if (readSession().identity !== identity || !identity) return;
      const revision = event.detail;
      if (!Number.isSafeInteger(revision) || revision < 0) return;
      if (profileRevision !== null && revision > profileRevision)
        scheduleProfileRefresh();
      profileRevision = revision;
    };
    window.addEventListener("madhouse:profile-revision", onProfileRevision);
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      const { signal } = controller;
      const session = readSession();
      const changed = identity !== session.identity;
      identity = session.identity;
      if (session.status !== "ready") {
        setState({ status: "idle", profile: null });
        return;
      }
      // Clear only for an account change; revalidation keeps the current view.
      if (changed) {
        profileRevision = null;
        clearTimeout(profileRefreshTimer);
        profileRefreshTimer = null;
        profileRefreshQueued = false;
        setState(cachedState());
      }
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
      if (readSession().identity !== identity) return;
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
      clearTimeout(profileRefreshTimer);
      window.removeEventListener(
        "madhouse:profile-revision",
        onProfileRevision,
      );
      unsubscribe();
      unsubscribeData();
      unsubscribeWork();
    };
  }, []);

  return state;
}
