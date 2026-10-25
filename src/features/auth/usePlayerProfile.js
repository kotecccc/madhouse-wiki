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
} from "./profile.js";

function playerProfile(data) {
  const profile = normalizePlayerProfile(data);
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
    const load = async () => {
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
        const data = await getSessionJson("/api/me", { signal });
        if (signal.aborted) return;
        setState({ status: "ready", profile: playerProfile(data) });
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
        setState({ status: "ready", profile: playerProfile(event.data) });
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
    void load();
    const unsubscribe = subscribeSession(load);
    return () => {
      controller?.abort();
      unsubscribe();
      unsubscribeData();
    };
  }, []);

  return state;
}
