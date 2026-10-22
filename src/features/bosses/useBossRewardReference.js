import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { readSession, subscribeSession } from "../../../shared/auth-session.js";
import { postSessionJson } from "../../../shared/session-api.js";
import { mergeKnowledgeBaseOverlay } from "../../model/knowledge-base.js";
import { createBossReferenceLoader } from "./boss-reference-loader.js";

const references = createBossReferenceLoader({
  async readSaved(id) {
    const response = await fetch(
      `/api/catalogue?bossId=${encodeURIComponent(id)}`,
      { cache: "no-store" },
    );
    if (!response.ok) throw new Error("Catalogue unavailable");
    return response.json();
  },
  importReference: (id) => postSessionJson("/api/catalogue", { bossId: id }),
  onReference: (boss) =>
    mergeKnowledgeBaseOverlay({ schemaVersion: 2, bosses: [boss] }),
});

// With a ref, import only once the card is actually visible. Without a ref,
// subscribe to the same shared data for field pickers and raid descriptions.
export function useBossRewardReference(boss, cardRef) {
  const id = String(boss?.apiId || "");
  const [visible, setVisible] = useState(false);
  const [authenticated, setAuthenticated] = useState(
    () => readSession().status === "ready",
  );
  const subscribe = useCallback(
    (listener) => references.subscribe(id, listener),
    [id],
  );
  const snapshot = useCallback(() => references.snapshot(id), [id]);
  const reference = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(
    () =>
      subscribeSession(() =>
        setAuthenticated(readSession().status === "ready"),
      ),
    [],
  );
  useEffect(() => {
    const element = cardRef?.current;
    if (!element) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [id, cardRef]);
  useEffect(() => {
    if (!visible || !/^[1-9][0-9]{0,8}$/.test(id) || boss.rewardPreviewCaptured)
      return;
    void references.ensure(id, authenticated);
  }, [id, visible, authenticated, boss.rewardPreviewCaptured]);
  // Keep local variation text/drop overrides; only enrich the reference reward.
  return reference.boss
    ? {
        ...boss,
        rewardPreview: reference.boss.rewardPreview,
        rewardPreviewCaptured: reference.boss.rewardPreviewCaptured,
      }
    : boss;
}
