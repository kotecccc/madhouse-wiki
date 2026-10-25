import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  getSessionJson,
  peekSessionJson,
  subscribeSessionData,
} from "../../../../shared/session-api.js";
import { readSession } from "../../../../shared/auth-session.js";
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
  const requestKey = JSON.stringify(
    enabled
      ? [
          ...new Set(
            getCollectionRequests(bosses.flatMap(getBossCollectibleDrops)),
          ),
        ].sort()
      : [],
  );
  const paths = useMemo(() => JSON.parse(requestKey), [requestKey]);
  const previousBattleRevision = useRef(revision);
  useEffect(
    () =>
      subscribeSessionData((event) => {
        if (event.cleared) {
          setState({ status: "idle", responses: {} });
          setSessionRevision((value) => value + 1);
        }
      }),
    [],
  );
  const readCachedResponses = () => {
    const responses = {};
    for (const path of paths) {
      const response = peekSessionJson(path, { allowStale: true });
      if (response !== null) responses[path] = response;
    }
    return responses;
  };
  const cachedResponses = readCachedResponses();
  useEffect(() => {
    const activePaths = new Set(paths);
    return subscribeSessionData((event) => {
      if (!event.path || !activePaths.has(event.path)) return;
      setState((current) => {
        if (
          current.key !== requestKey ||
          current.revision !== revision ||
          current.sessionRevision !== sessionRevision
        )
          return current;
        return {
          ...current,
          responses: { ...current.responses, [event.path]: event.data },
        };
      });
    });
  }, [requestKey, paths, revision, sessionRevision]);
  useEffect(() => {
    if (!enabled || readSession().status !== "ready") return;
    const refreshAfterBattle =
      Boolean(revision) && previousBattleRevision.current !== revision;
    previousBattleRevision.current = revision;
    const controller = new AbortController();
    const cachedResponses = {};
    for (const path of paths) {
      const response = peekSessionJson(path, { allowStale: true });
      if (response !== null) cachedResponses[path] = response;
    }
    setState((current) => ({
      status: "loading",
      responses: {
        ...(current.key === requestKey && current.responses),
        ...cachedResponses,
      },
      key: requestKey,
      revision,
      sessionRevision,
    }));
    const load = async () => {
      const responses = { ...cachedResponses };
      let failed = false;
      for (const path of JSON.parse(requestKey)) {
        if (controller.signal.aborted) return;
        try {
          responses[path] = await getSessionJson(path, {
            fresh: refreshAfterBattle,
          });
          if (!controller.signal.aborted)
            setState((current) =>
              current.key === requestKey &&
              current.revision === revision &&
              current.sessionRevision === sessionRevision
                ? {
                    ...current,
                    responses: {
                      ...current.responses,
                      [path]: responses[path],
                    },
                  }
                : current,
            );
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
  }, [requestKey, enabled, revision, sessionRevision, paths]);
  if (!enabled) return { status: "idle", responses: {} };
  if (
    state.key !== requestKey ||
    state.revision !== revision ||
    state.sessionRevision !== sessionRevision
  )
    return { status: "loading", responses: cachedResponses };
  return state;
}
