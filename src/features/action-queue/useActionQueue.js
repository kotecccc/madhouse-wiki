import { useEffect, useRef, useState } from "react";
import {
  getSessionJson,
  readStoredSessionJson,
  postSessionJson,
  subscribeSessionData,
} from "../../../shared/session-api.js";
import { workCollectionCompleted } from "./work-collection-completed.js";
import { stashCraftCompleted } from "./stash-craft-refresh.js";
import { syncBattleSession } from "../bosses/BossBattle/boss-battle-session.js";
import {
  startStoredStatePolling,
  storedQueuePresence,
} from "./stored-state-polling.js";

const pendingStatus = new Set(["queued", "waiting", "running", "reconciling"]);
const inventoryPath = (args) =>
  ({
    weapon: "/api/clothing/by-category/1",
    pet: "/api/clothing/by-category/9",
    room: "/api/rooms",
    clothing_item: "/api/clothing",
  })[args.type];

export function useActionQueue(
  authenticated,
  sessionGeneration,
  onFriendCompleted,
  onWorkCollectionCompleted,
  inventoryActive = false,
) {
  const [state, setState] = useState(null);
  const [presence, setPresence] = useState("unknown");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const prior = useRef(new Map());
  const hasPresentSnapshot = useRef(false);
  const inventoryActiveRef = useRef(inventoryActive);
  inventoryActiveRef.current = inventoryActive;
  useEffect(() => {
    prior.current = new Map();
    hasPresentSnapshot.current = false;
    setState(null);
    setPresence("unknown");
    setError(null);
    if (!authenticated) return;
    let cancelled = false;
    let previousWork = null;
    let polling;
    const observedCollectionJobs = new Set();
    const notifiedCollections = new Set();
    let queueInitialized = false;
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
      const completedWorkKey =
        work?.queueId ||
        (Number.isFinite(work?.startedAt)
          ? `${work.workId}:${work.startedAt}`
          : null);
      const observedQueuedCompletion =
        work?.status === "completed" &&
        work.config?.collectStash &&
        work.queueId &&
        observedCollectionJobs.has(work.queueId);
      if (
        completedWorkKey &&
        !notifiedCollections.has(completedWorkKey) &&
        (workCollectionCompleted(previousWork, work) ||
          observedQueuedCompletion)
      ) {
        notifiedCollections.add(completedWorkKey);
        onWorkCollectionCompleted?.(work);
      }
      previousWork = work
        ? {
            status: work.status,
            queueId: work.queueId,
            workId: work.workId,
            startedAt: work.startedAt,
            collectStash: work.config?.collectStash,
          }
        : null;
      for (const job of next.queuedActions) {
        if (
          job.type === "work.start" &&
          job.args?.collectStash &&
          pendingStatus.has(job.status)
        )
          observedCollectionJobs.add(job.id);
        const before = prior.current.get(job.id);
        if (stashCraftCompleted(job, before, queueInitialized)) {
          void getSessionJson("/api/stash/sets", {
            fresh: true,
            revalidate: false,
          }).catch(() => {});
          for (const path of ["/api/me", "/api/me/bag"]) {
            void getSessionJson(path, {
              fresh: true,
              serverRefresh: "live",
              afterPending: true,
              revalidate: false,
            }).catch(() => {});
          }
        }
        if (
          job.type === "inventory" &&
          before &&
          before !== "completed" &&
          job.status === "completed"
        ) {
          const path = inventoryPath(job.args);
          if (path && inventoryActiveRef.current)
            void getSessionJson(path, { fresh: true, revalidate: false }).catch(
              () => {},
            );
          void getSessionJson("/api/me", {
            fresh: true,
            revalidate: false,
          }).catch(() => {});
        }
        if (
          ["work.booster", "energy.booster"].includes(job.type) &&
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
      queueInitialized = true;
      setState(next);
      syncBattleSession(next);
    };
    const unsubscribe = subscribeSessionData((event) => {
      if (event.cleared) {
        polling?.invalidate();
        prior.current.clear();
        observedCollectionJobs.clear();
        notifiedCollections.clear();
        previousWork = null;
        queueInitialized = false;
        hasPresentSnapshot.current = false;
        setState(null);
        setPresence("unknown");
      } else if (
        ["/api/automation/state", "/api/automation/commands"].includes(
          event.path,
        )
      ) {
        if (!Array.isArray(event.data?.queuedActions)) return;
        polling?.invalidate();
        hasPresentSnapshot.current = true;
        setPresence("present");
        update(event.data);
      }
    });
    polling = startStoredStatePolling({
      readStored: () => readStoredSessionJson("/api/automation/state"),
      onPresent: (next) => {
        hasPresentSnapshot.current = true;
        setPresence("present");
        update(next);
      },
      onMissing: (saved) => {
        if (!hasPresentSnapshot.current)
          setPresence(storedQueuePresence(saved));
      },
      onUnavailable: () => {
        if (!hasPresentSnapshot.current) setPresence("unavailable");
      },
    });
    return () => {
      cancelled = true;
      polling.stop();
      unsubscribe();
    };
  }, [
    authenticated,
    sessionGeneration,
    onFriendCompleted,
    onWorkCollectionCompleted,
  ]);
  async function command(card) {
    if (!state || pending) return;
    setPending(true);
    setError(null);
    try {
      const args = ["queue.cancel", "queue.dismiss", "queue.move"].includes(
        card.command,
      )
        ? {
            id: card.id,
            ...(card.command === "queue.move"
              ? { direction: card.direction }
              : {}),
          }
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
      setError(
        card.command === "queue.move"
          ? "Не удалось изменить порядок очереди. Обновите её и попробуйте снова."
          : "Не удалось остановить действие. Попробуйте ещё раз.",
      );
    } finally {
      setPending(false);
    }
  }
  return { state, presence, pending, error, command };
}
