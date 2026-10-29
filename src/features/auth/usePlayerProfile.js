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
  if (readSession().status !== "ready")
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
        return authorizeRequest({ url: "/api/me" }).headers.Authorization;
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
      if (session.status !== "ready") {
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
      const requestLevel = async () => {
        const request = authorizeRequest({
          url: "/api/automation/profile-level",
        });
        const response = await fetch(request.url, {
          headers: request.headers,
          cache: "no-store",
          signal,
        });
        if (!response.ok) throw new Error("level_unavailable");
        return response.json();
      };
      // The server resolves the verified account itself, so the level read can
      // start before /api/me. Keep failures handled until the profile arrives.
      const earlyLevel = requestLevel().catch(() => null);
      const loadLevel = async (playerId, early = null) => {
        setState((current) => ({ ...current, levelStatus: "loading" }));
        try {
          const data = (early && (await early)) || (await requestLevel());
          if (
            data.playerId !== playerId ||
            !Number.isSafeInteger(data.level) ||
            data.level < 1
          )
            throw new Error("level_unavailable");
          if (!signal.aborted && sessionIdentity() === currentIdentity)
            setState((current) =>
              current.profile?.playerId === playerId
                ? {
                    ...current,
                    levelStatus: "ready",
                    profile: {
                      ...current.profile,
                      playerLevel: data.level,
                      experience:
                        current.profile.playerLevel != null &&
                        current.profile.playerLevel !== data.level
                          ? { current: undefined, toNextLevel: undefined }
                          : current.profile.experience,
                    },
                  }
                : current,
            );
        } catch {
          if (!signal.aborted && sessionIdentity() === currentIdentity)
            setState((current) => ({
              ...current,
              levelStatus: "error",
              profile:
                current.profile?.playerId === current.identity?.playerId &&
                Number.isSafeInteger(current.identity?.playerLevel)
                  ? {
                      ...current.profile,
                      playerLevel: current.identity.playerLevel,
                    }
                  : current.profile,
            }));
        }
      };
      void (async () => {
        try {
          const request = authorizeRequest({
            url: "/api/automation/profile-identity",
          });
          const response = await fetch(request.url, {
            headers: request.headers,
            cache: "no-store",
            signal,
          });
          if (!response.ok) return;
          const data = await response.json();
          if (!signal.aborted && sessionIdentity() === currentIdentity) {
            window.dispatchEvent(
              new CustomEvent("madhouse:profile-identity", { detail: data }),
            );
            setState((current) => {
              const cached = profileIdentity(data);
              return {
                ...current,
                identity: cached,
                profile:
                  current.profile?.playerId === cached.playerId
                    ? retainProfileProgress(current.profile, cached)
                    : current.profile,
              };
            });
          }
        } catch {
          // Identity is optional; the fresh profile remains authoritative.
        }
      })();
      try {
        // The public account snapshot can be old even when it is returned with
        // a successful HTTP response. Revalidate it on mount and keep the
        // current profile in state if the live refresh fails.
        const data = await getSessionJson("/api/me", {
          signal,
          revalidate: false,
        });
        if (signal.aborted) return;
        setState((current) => ({
          ...current,
          status: "ready",
          profile: livePlayerProfile(data, current.profile ?? current.identity),
          levelStatus: Number.isSafeInteger(data.exp?.level)
            ? "ready"
            : "loading",
        }));
        if (!Number.isSafeInteger(data.exp?.level))
          void loadLevel(data.playerId, earlyLevel);
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
