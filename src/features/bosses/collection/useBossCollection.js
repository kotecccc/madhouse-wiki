import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  getSessionJson,
  peekSessionJson,
  reportGameHealth,
  subscribeSessionData,
} from "../../../../shared/session-api.js";
import { readSession } from "../../../../shared/auth-session.js";
import { bossBattle } from "../BossBattle/boss-battle-session.js";

const path = "/api/automation/bosses";
const battleRevision = () => {
  const battle = bossBattle.getSnapshot().battle;
  return battle?.status === "won" ? `${battle.id}:won` : "";
};
const result = (data) => ({ status: "ready", bosses: data.bosses });

// The private server response contains each reference card and its collection together.
export function useBossCollection(_bosses, enabled) {
  const revision = useSyncExternalStore(
    bossBattle.subscribe,
    battleRevision,
    () => "",
  );
  const previousRevision = useRef(revision);
  const [sessionRevision, setSessionRevision] = useState(0);
  const [state, setState] = useState({ status: "idle" });
  useEffect(
    () =>
      subscribeSessionData(
        (event) => {
          if (event.cleared) {
            setState({ status: "idle" });
            setSessionRevision((value) => value + 1);
          } else if (event.path === path && Array.isArray(event.data?.bosses)) {
            if (event.data.gameHealth) reportGameHealth(event.data.gameHealth);
            setState(result(event.data));
          }
        },
        { resources: enabled ? [path] : [], revalidate: false },
      ),
    [enabled],
  );
  useEffect(() => {
    if (!enabled || readSession().status !== "ready") return;
    const fresh = Boolean(revision) && previousRevision.current !== revision;
    previousRevision.current = revision;
    const boss = bossBattle.getSnapshot().boss;
    const refreshBoss = fresh
      ? Number(boss?.numericId ?? boss?.apiId ?? boss?.id)
      : undefined;
    const controller = new AbortController();
    const cached = peekSessionJson(path, { allowStale: true });
    if (Array.isArray(cached?.bosses)) setState(result(cached));
    else setState({ status: "loading" });
    void getSessionJson(path, {
      signal: controller.signal,
      fresh,
      refreshBoss,
      revalidate: false,
    })
      .then((data) => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(data?.bosses)) throw new Error("invalid_boss_cards");
        if (data.gameHealth) reportGameHealth(data.gameHealth);
        setState(result(data));
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setState((current) =>
            current.bosses ? current : { status: "error" },
          );
      });
    return () => controller.abort();
  }, [enabled, revision, sessionRevision]);
  if (!enabled) return { status: "idle" };
  if (state.status === "idle" && readSession().status === "ready")
    return { status: "loading" };
  return state;
}
