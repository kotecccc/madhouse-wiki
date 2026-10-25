import { useEffect, useState, useSyncExternalStore } from "react";
import {
  readSession,
  subscribeSession,
} from "../../../../shared/auth-session.js";
import { getSessionJson } from "../../../../shared/session-api.js";
import { bossBattle } from "../BossBattle/boss-battle-session.js";
import { isTerminalBossBattle } from "../BossBattle/boss-battle-status.js";
import {
  getBossCollectibleDrops,
  getCollectionRequests,
} from "./boss-collection.js";

const battleRevision = () => {
  const battle = bossBattle.getSnapshot().battle;
  return battle && isTerminalBossBattle(battle)
    ? `${battle.id}:${battle.status}`
    : "";
};

// Account-only view data. Never merged into the public reference catalogue.
export function useBossCollection(bosses, enabled) {
  const [sessionRevision, setSessionRevision] = useState(0);
  const revision = useSyncExternalStore(
    bossBattle.subscribe,
    battleRevision,
    () => "",
  );
  const [state, setState] = useState({ status: "idle", responses: {} });
  const paths = enabled
    ? [
        ...new Set(
          getCollectionRequests(bosses.flatMap(getBossCollectibleDrops)),
        ),
      ].sort()
    : [];
  const requestKey = JSON.stringify(paths);
  useEffect(
    () =>
      subscribeSession(() => {
        setState({ status: "idle", responses: {} });
        setSessionRevision((value) => value + 1);
      }),
    [],
  );
  useEffect(() => {
    if (!enabled || readSession().status !== "ready") return;
    const controller = new AbortController();
    setState({ status: "loading", responses: {} });
    const load = async () => {
      const responses = {};
      let failed = false;
      for (const path of JSON.parse(requestKey)) {
        if (controller.signal.aborted) return;
        try {
          responses[path] = await getSessionJson(path, {
            fresh: Boolean(revision),
          });
        } catch {
          if (controller.signal.aborted) return;
          failed = true;
        }
      }
      if (!controller.signal.aborted)
        setState({
          status: failed ? "partial" : "ready",
          responses,
          key: requestKey,
          revision,
          sessionRevision,
        });
    };
    void load();
    return () => controller.abort();
  }, [requestKey, enabled, revision, sessionRevision]);
  if (!enabled) return { status: "idle", responses: {} };
  if (
    state.key !== requestKey ||
    state.revision !== revision ||
    state.sessionRevision !== sessionRevision
  )
    return { status: "loading", responses: {} };
  return state;
}
