import { useEffect, useRef, useState } from "react";
import { postSessionJson } from "../../../shared/session-api.js";
import { workCollectionCompleted } from "./work-collection-completed.js";
import {
  automationState,
  syncBattleSession,
} from "../bosses/BossBattle/boss-battle-session.js";

const pendingStatus = new Set(["queued", "waiting", "running", "reconciling"]);

export function useActionQueue(
  authenticated,
  sessionGeneration,
  onFriendCompleted,
  onWorkCollectionCompleted,
) {
  const [state, setState] = useState(null);
  const [presence, setPresence] = useState("unknown");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const prior = useRef(new Map());
  const hasPresentSnapshot = useRef(false);
  useEffect(() => {
    prior.current = new Map();
    hasPresentSnapshot.current = false;
    setState(null);
    setPresence("unknown");
    setError(null);
    if (!authenticated) return;
    let cancelled = false;
    let previousWork = null;
    const observedCollectionJobs = new Set();
    const notifiedCollections = new Set();
    const update = (next) => {
      if (cancelled || !next || !Array.isArray(next.queuedActions)) return;
      const work = next.workFarm?.run;
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
    };
    const sync = () => {
      const current = automationState.getSnapshot();
      if (current.presence === "unknown") {
        prior.current.clear();
        observedCollectionJobs.clear();
        notifiedCollections.clear();
        previousWork = null;
        hasPresentSnapshot.current = false;
        setState(null);
        setPresence("unknown");
      } else if (current.presence === "present") {
        hasPresentSnapshot.current = true;
        setPresence("present");
        update(current.data);
      } else if (!hasPresentSnapshot.current) {
        setPresence(current.presence);
      }
    };
    const unsubscribe = automationState.subscribe(sync);
    sync();
    return () => {
      cancelled = true;
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
