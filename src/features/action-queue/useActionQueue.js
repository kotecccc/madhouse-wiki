import { useEffect, useRef, useState } from "react";
import {
  getSessionJson,
  postSessionJson,
  subscribeSessionData,
} from "../../../shared/session-api.js";
import { syncBattleSession } from "../bosses/BossBattle/boss-battle-session.js";

const pendingStatus = new Set(["queued", "waiting", "running", "reconciling"]);
const inventoryPath = (args) =>
  ({
    weapon: "/api/clothing/by-category/1",
    pet: "/api/clothing/by-category/9",
    room: "/api/rooms",
    clothing_item: "/api/clothing",
    ornament: `/api/ornaments/zones/${args.zoneId}`,
  })[args.type];

export function useActionQueue(
  authenticated,
  sessionGeneration,
  onFriendCompleted,
) {
  const [state, setState] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const prior = useRef(new Map());
  useEffect(() => {
    prior.current = new Map();
    setState(null);
    setError(null);
    if (!authenticated) return;
    let cancelled = false;
    let timer;
    let previousWork = null;
    const update = (next) => {
      if (cancelled || !next || !Array.isArray(next.queuedActions)) return;
      const work = next.workFarm?.run;
      if (
        previousWork?.status === "running" &&
        previousWork.collectStash &&
        previousWork.queueId === work?.queueId &&
        ["completed", "limited", "stopped"].includes(work.status)
      ) {
        void getSessionJson("/api/stash/sets", {
          fresh: true,
          revalidate: false,
        }).catch(() => {});
      }
      previousWork = work
        ? {
            status: work.status,
            queueId: work.queueId,
            collectStash: work.config?.collectStash,
          }
        : null;
      for (const job of next.queuedActions) {
        const before = prior.current.get(job.id);
        if (
          job.type === "stash.craft" &&
          before &&
          before !== "completed" &&
          job.status === "completed"
        ) {
          void getSessionJson("/api/stash/sets", {
            fresh: true,
            revalidate: false,
          }).catch(() => {});
          void getSessionJson("/api/me", {
            fresh: true,
            serverRefresh: "live",
            revalidate: false,
          }).catch(() => {});
        }
        if (
          job.type === "inventory" &&
          before &&
          before !== "completed" &&
          job.status === "completed"
        ) {
          const path = inventoryPath(job.args);
          if (path)
            void getSessionJson(path, { fresh: true, revalidate: false }).catch(
              () => {},
            );
          void getSessionJson("/api/me", {
            fresh: true,
            revalidate: false,
          }).catch(() => {});
        }
        if (
          job.type === "work.booster" &&
          before &&
          before !== "completed" &&
          job.status === "completed"
        ) {
          void getSessionJson("/api/me", {
            fresh: true,
            revalidate: false,
          }).catch(() => {});
          void getSessionJson("/api/me/bag", {
            fresh: true,
            revalidate: false,
          }).catch(() => {});
        }
        if (
          job.type === "friend.remove" &&
          before &&
          before !== "completed" &&
          job.status === "completed"
        )
          onFriendCompleted?.();
      }
      prior.current = new Map(
        next.queuedActions.map((job) => [job.id, job.status]),
      );
      setState(next);
      syncBattleSession(next);
    };
    const unsubscribe = subscribeSessionData((event) => {
      if (event.cleared) {
        prior.current.clear();
        setState(null);
      } else if (
        ["/api/automation/state", "/api/automation/commands"].includes(
          event.path,
        )
      )
        update(event.data);
    });
    const poll = async () => {
      try {
        const next = await getSessionJson("/api/automation/state", {
          fresh: true,
          revalidate: false,
        });
        update(next);
        if (!cancelled)
          timer = setTimeout(
            poll,
            next.queuedActions?.some((job) => pendingStatus.has(job.status))
              ? 3000
              : 15000,
          );
      } catch {
        if (!cancelled) timer = setTimeout(poll, 15000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [authenticated, sessionGeneration, onFriendCompleted]);
  async function command(card) {
    if (!state || pending) return;
    setPending(true);
    setError(null);
    try {
      const args = ["queue.cancel", "queue.dismiss"].includes(card.command)
        ? { id: card.id }
        : {};
      const next = await postSessionJson("/api/automation/commands", {
        id: crypto.randomUUID(),
        expectedVersion: state.version,
        command: card.command,
        args,
      });
      setState(next);
      syncBattleSession(next);
    } catch {
      setError("Не удалось остановить действие. Попробуйте ещё раз.");
    } finally {
      setPending(false);
    }
  }
  return { state, pending, error, command };
}
