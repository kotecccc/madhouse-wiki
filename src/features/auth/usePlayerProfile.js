import { useEffect, useState } from "react";
import {
  getSessionJson,
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
import {
  characterUpgrade,
  workFarm,
} from "../bosses/BossBattle/boss-battle-session.js";
import { hasNewCharacterUpgradeProgress } from "./character-upgrade-progress.js";

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
    let workStatus = workFarm.getSnapshot().run?.status;
    let characterRun = characterUpgrade.getSnapshot().run;
    let profileRevision = null;
    let profileRefreshTimer = null;
    let profileRefreshRunning = false;
    let profileRefreshQueued = false;
    const refreshChangedProfile = async () => {
      clearTimeout(profileRefreshTimer);
      profileRefreshTimer = null;
      if (profileRefreshRunning) {
        profileRefreshQueued = true;
        return;
      }
      if (sessionIdentity() !== identity || !identity) return;
      profileRefreshRunning = true;
      try {
        await getSessionJson("/api/me", {
          revalidate: false,
        });
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
      if (sessionIdentity() !== identity || !identity) return;
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
      const currentIdentity = sessionIdentity();
      const changed = identity !== currentIdentity;
      identity = currentIdentity;
      if (session.status !== "ready" && !session.wikiSessionReady) {
        setState({ status: "idle", profile: null });
        return;
      }
      // Clear only for an account change; revalidation keeps the current view.
      if (changed) {
        profileRevision = null;
        characterRun = null;
        clearTimeout(profileRefreshTimer);
        profileRefreshTimer = null;
        profileRefreshQueued = false;
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
    const unsubscribeData = subscribeSessionData((event) => {
      if (event.cleared) {
        setState(cachedState());
      } else if (event.path === "/api/me") {
        if (event.liveRefresh && event.snapshotStatus !== "stale") {
          setState((current) => ({
            ...current,
            status: "ready",
            profile: livePlayerProfile(
              event.data,
              current.profile ?? current.identity,
            ),
            updatedAt: event.updatedAt ?? current.updatedAt,
            snapshotStatus: event.snapshotStatus ?? current.snapshotStatus,
            snapshotCompleteness:
              event.snapshotCompleteness ?? current.snapshotCompleteness,
          }));
        } else {
          setState((current) => ({
            ...current,
            identity: profileIdentity(event.data),
          }));
        }
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
    const unsubscribeCharacter = characterUpgrade.subscribe(() => {
      if (!identity || sessionIdentity() !== identity) return;
      const run = characterUpgrade.getSnapshot().run;
      if (hasNewCharacterUpgradeProgress(characterRun, run))
        void refreshChangedProfile();
      characterRun = run ? { id: run.id, completed: run.completed } : null;
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
      unsubscribeCharacter();
    };
  }, []);

  return state;
}
