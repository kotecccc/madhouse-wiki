import { ActionQueueSection } from "../../features/action-queue/ActionQueueSection.jsx";
import { useActionQueue } from "../../features/action-queue/useActionQueue.js";
import { AccountSummary } from "../../components/layout/SiteHeader/AccountSummary.jsx";
import { Toast } from "../../components/ui/Toast/Toast.jsx";
import { FriendsSection } from "../../features/friends/FriendsSection.jsx";
import { ToastTargetContext } from "../../components/ui/Toast/ToastContext.jsx";
import {
  inventoryCategories,
  inventoryCategoryOptions,
  inventoryPaths,
} from "../../features/inventory/inventory.js";
import { InventorySection } from "../../features/inventory/InventorySection.jsx";
import { BossBattleDialog } from "../../features/bosses/BossBattle/BossBattleDialog.jsx";
import { BossInvitationsDialog } from "../../features/bosses/BossInvitations/BossInvitations.jsx";
import { bossBattle } from "../../features/bosses/BossBattle/boss-battle-session.js";
import { CharacterUpgrade } from "../../features/overview/CharacterUpgrade/CharacterUpgrade.jsx";
import { WorkFarmDialog } from "../../features/works/WorkCard/WorkFarmDialog.jsx";
import { ActiveBattleControl } from "../../features/combat/ActiveBattleDock/ActiveBattleDock.jsx";
import { BottomDock } from "../../components/layout/BottomDock/BottomDock.jsx";
import { knowledgeBase as kb } from "virtual:madhouse-catalogue";
import "./App.css";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  readSessionRefreshState,
  subscribeSessionData,
  getSessionJson,
} from "../../../shared/session-api.js";
import { CardDescription } from "../../components/ui/CardDescription/CardDescription.jsx";
import { SiteHeader } from "../../components/layout/SiteHeader/SiteHeader.jsx";
import { SiteFooter } from "../../components/layout/SiteFooter/SiteFooter.jsx";
import { FloorsSection } from "../../features/floors/FloorsSection/FloorsSection.jsx";
import { RequirementCalculatorDialog } from "../../features/calculator/RequirementCalculatorDialog/RequirementCalculatorDialog.jsx";
import { UpgradeDialog } from "../../features/businesses/UpgradeDialog/UpgradeDialog.jsx";
import { RaidScheduleSection } from "../../features/raids/RaidScheduleSection/RaidScheduleSection.jsx";
import { queueNavigation } from "../../features/action-queue/queue-navigation.js";
import { TelegramLaunchScreen } from "../../features/telegram/TelegramLaunchScreen/TelegramLaunchScreen.jsx";
import { MobileNavigation } from "../../components/layout/MobileNavigation/MobileNavigation.jsx";
import { GameHealthWarningBanner } from "../../components/layout/BottomDock/GameHealthWarning.jsx";
import { FeedbackWidget } from "../../features/support/FeedbackWidget/FeedbackWidget.jsx";
import { useFloorAvailability } from "../../features/floors/useFloorAvailability.js";
import { readSession, subscribeSession } from "../../../shared/auth-session.js";
import { AUTH_RESTORE_SETTLED_EVENT } from "../../../shared/auth-session.js";
import { usePlayerProfile } from "../../features/auth/usePlayerProfile.js";
import { OverviewSection } from "../../features/overview/OverviewSection/OverviewSection.jsx";
import { useRaidSchedule } from "../../features/raids/useRaidSchedule.js";

import { screenFromHash } from "./app-screen.js";
import { usePullRefresh } from "./usePullRefresh.js";
import { PullRefresh } from "../../components/ui/PullRefresh/PullRefresh.jsx";

export function App() {
  const [toastTarget, setToastTarget] = useState(null);
  const refreshing = useSyncExternalStore(
    subscribeSessionData,
    readSessionRefreshState,
    () => false,
  );
  const scrollRegionRef = useRef(null);
  const profileState = usePlayerProfile();
  const floorAvailability = useFloorAvailability();
  const raidSchedule = useRaidSchedule();
  const [upgradeDialog, setUpgradeDialog] = useState(null);
  const [conditionDialog, setConditionDialog] = useState(null);
  const [queueDialog, setQueueDialog] = useState(null);
  const [sessionStatus, setSessionStatus] = useState(
    () => readSession().status,
  );
  const authenticated = sessionStatus === "ready";
  const [activeScreen, setActiveScreen] = useState(() =>
    typeof window === "undefined"
      ? "overview"
      : screenFromHash(window.location.hash),
  );
  const visibleScreen =
    ["inventory", "friends"].includes(activeScreen) && !authenticated
      ? "overview"
      : activeScreen;
  const [departmentState, setDepartmentState] = useState(null);
  const [floorContentLoading, setFloorContentLoading] = useState(false);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryNotice, setInventoryNotice] = useState(null);
  const [inventoryTarget, setInventoryTarget] = useState(null);
  const [floorFocusCode, setFloorFocusCode] = useState(null);
  const [visibleFloorCode, setVisibleFloorCode] = useState(null);
  const [queueFocus, setQueueFocus] = useState(null);
  const [friendsRefresh, setFriendsRefresh] = useState(0);
  const [sessionGeneration, setSessionGeneration] = useState(0);
  const onFriendCompleted = useCallback(
    () => setFriendsRefresh((value) => value + 1),
    [],
  );
  const actionQueue = useActionQueue(
    authenticated,
    sessionGeneration,
    onFriendCompleted,
  );
  const [inventoryResponses, setInventoryResponses] = useState({});
  const [inventoryDirty, setInventoryDirty] = useState([]);
  const inventoryPathsSet = useRef(
    new Set(
      inventoryCategories.flatMap(({ id }) =>
        inventoryPaths(id, kb.inventoryItems || []),
      ),
    ),
  );
  useEffect(() => {
    if (!authenticated) {
      setInventoryResponses({});
      setInventoryDirty([]);
      return;
    }
    let cancelled = false;
    const updated = new Set();
    const unsubscribe = subscribeSessionData((event) => {
      if (event.cleared) setInventoryResponses({});
      else if (inventoryPathsSet.current.has(event.path) && event.data) {
        updated.add(event.path);
        setInventoryDirty((current) =>
          current.filter((path) => path !== event.path),
        );
        setInventoryResponses((current) => ({
          ...current,
          [event.path]: event.data,
        }));
      }
    });
    getSessionJson("/api/automation/inventory-snapshots", { fresh: true })
      .then((saved) => {
        if (!cancelled) {
          setInventoryDirty(
            (saved.dirty || []).filter((path) => !updated.has(path)),
          );
          setInventoryResponses((current) => ({
            ...saved.sections,
            ...Object.fromEntries(
              [...updated]
                .filter((path) => current[path])
                .map((path) => [path, current[path]]),
            ),
          }));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [authenticated, profileState.profile?.playerLevel, sessionGeneration]);
  const inventoryCount = inventoryCategoryOptions(
    inventoryResponses,
    kb.inventoryItems || [],
  ).reduce((sum, option) => sum + (option.count || 0), 0);
  const pull = usePullRefresh({
    regionRef: scrollRegionRef,
    enabled: visibleScreen === "overview",
    onRefresh: async () => {
      floorAvailability.retry();
      if (!authenticated) return;
      const paths = new Set([
        "/api/me",
        "/api/me/bag",
        "/api/floors",
        "/api/stash/sets",
      ]);
      for (const code of [visibleFloorCode, departmentState?.code])
        if (code) paths.add(`/api/floors/${encodeURIComponent(code)}/info`);
      await Promise.allSettled(
        [...paths].map((path) =>
          getSessionJson(path, {
            fresh: true,
            serverRefresh: "live",
            afterPending: true,
          }),
        ),
      );
    },
  });

  useEffect(() => {
    const syncSession = () => setSessionStatus(readSession().status);
    const unsubscribe = subscribeSession(() => {
      syncSession();
      setSessionGeneration((value) => value + 1);
    });
    const timer = window.setInterval(syncSession, 1000);
    window.addEventListener(AUTH_RESTORE_SETTLED_EVENT, syncSession);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
      window.removeEventListener(AUTH_RESTORE_SETTLED_EVENT, syncSession);
    };
  }, []);

  useEffect(() => {
    const syncScreen = () => {
      const next = screenFromHash(window.location.hash);
      setActiveScreen(next);
      if (window.location.hash !== `#${next}`)
        window.history.replaceState(null, "", `#${next}`);
    };
    syncScreen();
    window.addEventListener("hashchange", syncScreen);
    return () => window.removeEventListener("hashchange", syncScreen);
  }, []);

  function changeScreen(screen) {
    const next = screenFromHash(`#${screen}`);
    setActiveScreen(next);
    window.history.replaceState(null, "", `#${next}`);
    scrollRegionRef.current?.scrollTo({ top: 0, behavior: "instant" });
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  const onOpenFloors = (code) => {
    setFloorFocusCode(code || null);
    changeScreen("overview");
  };
  const onOpenRaids = () => changeScreen("raids");
  const onQueueFocusHandled = useCallback((kind) => {
    setQueueFocus((current) => (current?.kind === kind ? null : current));
  }, []);
  const openQueueAction = (card) => {
    const type = card.destination;
    const navigation = queueNavigation(card, kb);
    if (navigation) {
      if (navigation.screen === "overview")
        setFloorFocusCode(navigation.floorCode);
      setQueueFocus(navigation.focus);
      changeScreen(navigation.screen);
      return;
    }
    if (["work", "work.start", "work.booster"].includes(type) && card.work) {
      setQueueDialog({ type: "work", work: card.work });
    } else if (type === "character" || type === "character.start") {
      setQueueDialog({ type: "character" });
    } else if (type === "business" || type === "business.start") {
      const business = kb.businesses.find(
        (item) => item.id === card.businessId,
      );
      if (business)
        setUpgradeDialog({
          business,
          upgrade: kb.businessUpgrades.find(
            (item) => item.businessId === business.id,
          ),
        });
      else changeScreen("overview");
    } else if (
      ["auto", "goal", "raid"].includes(type) ||
      type.startsWith("battle.") ||
      type === "auto.start" ||
      type === "raid.start"
    ) {
      const boss = card.bossId
        ? kb.bosses.find(
            (item) =>
              String(item.id) === String(card.bossId) ||
              Number(item.numericId ?? item.apiId) === Number(card.bossId),
          )
        : actionQueue.state?.battle?.boss;
      if (boss) void bossBattle.open(boss);
      else changeScreen("overview");
    } else if (type === "inventory") {
      setInventoryTarget(
        card.inventoryTarget ? { ...card.inventoryTarget } : null,
      );
      changeScreen("inventory");
    } else if (type === "invitation.accept") {
      setQueueDialog({ type: "invitations" });
    } else {
      changeScreen("overview");
    }
  };
  const onDepartmentState = useCallback((state) => {
    if (state?.status === "ready" || state?.status === "error")
      setDepartmentState(state);
  }, []);

  useEffect(() => {
    if (!authenticated || floorAvailability.status !== "ready")
      setDepartmentState(null);
  }, [authenticated, floorAvailability.status]);

  return (
    <ToastTargetContext.Provider value={toastTarget}>
      <div className="site-shell">
        <div className="site-header-group">
          <SiteHeader
            loading={
              refreshing ||
              pull.loading ||
              profileState.status === "loading" ||
              floorAvailability.status === "loading" ||
              floorContentLoading ||
              inventoryLoading ||
              raidSchedule.status === "loading"
            }
          />
          {authenticated && (
            <AccountSummary
              key={profileState.profile?.playerId ?? "loading"}
              profile={profileState.profile}
            />
          )}
        </div>
        <div
          className="app-scroll-region"
          ref={scrollRegionRef}
          data-page-scroll
        >
          <PullRefresh {...pull} />
          <MobileNavigation
            desktop
            inventoryCount={inventoryCount}
            authenticated={authenticated}
            activeScreen={visibleScreen}
            onScreenChange={changeScreen}
          />
          <main
            id="top"
            className={`app-content app-content--${visibleScreen}`}
          >
            <div
              id="screen-overview"
              className="app-screen app-screen--overview"
            >
              {authenticated && (
                <OverviewSection
                  profileState={profileState}
                  floorAvailability={floorAvailability}
                  departmentState={departmentState}
                  schedule={raidSchedule}
                  onOpenFloors={onOpenFloors}
                  onOpenRaids={onOpenRaids}
                  onRetryFloors={floorAvailability.retry}
                />
              )}
              <div className="app-floor-catalogue">
                {kb.floors.length === 0 && (
                  <p role="status">Справочник ещё не заполнен.</p>
                )}
                <FloorsSection
                  {...floorAvailability}
                  isAuthenticated={authenticated}
                  playerLevel={
                    authenticated && profileState.status === "ready"
                      ? profileState.profile.playerLevel
                      : null
                  }
                  onCalculator={setConditionDialog}
                  onUpgradeSelect={setUpgradeDialog}
                  onDepartmentState={onDepartmentState}
                  onLoadingChange={setFloorContentLoading}
                  selectedFloorCode={floorFocusCode}
                  queueFocus={queueFocus?.kind === "floor" ? queueFocus : null}
                  onQueueFocusHandled={onQueueFocusHandled}
                  onVisibleFloorChange={setVisibleFloorCode}
                />
              </div>
            </div>
            <div id="screen-raids" className="app-screen app-screen--raids">
              <RaidScheduleSection
                authenticated={authenticated}
                active={visibleScreen === "raids"}
                queueFocus={queueFocus?.kind === "raid" ? queueFocus : null}
                onQueueFocusHandled={onQueueFocusHandled}
                availability={floorAvailability.availability}
                state={raidSchedule}
                onRetry={raidSchedule.retry}
              />
            </div>
            {visibleScreen === "queue" && (
              <div id="screen-queue" className="app-screen app-screen--queue">
                <ActionQueueSection
                  authenticated={authenticated}
                  state={actionQueue.state}
                  catalogue={kb}
                  onCommand={actionQueue.command}
                  onOpen={openQueueAction}
                  pending={actionQueue.pending}
                />
                {actionQueue.error && (
                  <CardDescription role="alert">
                    {actionQueue.error}
                  </CardDescription>
                )}
              </div>
            )}
            {authenticated && visibleScreen === "friends" && (
              <div
                id="screen-friends"
                className="app-screen app-screen--friends"
              >
                <FriendsSection
                  key={sessionGeneration}
                  active
                  refreshGeneration={friendsRefresh}
                  onNotice={setInventoryNotice}
                  queueFocus={
                    ["friend", "buddy"].includes(queueFocus?.kind)
                      ? queueFocus
                      : null
                  }
                  onQueueFocusHandled={onQueueFocusHandled}
                />
              </div>
            )}
            {authenticated && (
              <div
                id="screen-inventory"
                className="app-screen app-screen--inventory"
              >
                <InventorySection
                  active={visibleScreen === "inventory"}
                  responses={inventoryResponses}
                  dirtyPaths={inventoryDirty}
                  playerLevel={profileState.profile?.playerLevel}
                  target={inventoryTarget}
                  onNotice={setInventoryNotice}
                  onLoadingChange={setInventoryLoading}
                />
              </div>
            )}
          </main>
          <SiteFooter>
            <FeedbackWidget screen={activeScreen} />
          </SiteFooter>
        </div>
        <BottomDock toastRef={setToastTarget}>
          {inventoryNotice ? (
            <Toast
              urgent={!inventoryNotice.success}
              success={inventoryNotice.success}
              title={inventoryNotice.success ? "В очереди" : "Ошибка"}
              onDismiss={() => setInventoryNotice(null)}
            >
              {inventoryNotice.message}
            </Toast>
          ) : (
            <GameHealthWarningBanner />
          )}
          <ActiveBattleControl>
            <MobileNavigation
              activeScreen={visibleScreen}
              inventoryCount={inventoryCount}
              authenticated={authenticated}
              onScreenChange={changeScreen}
            />
          </ActiveBattleControl>
        </BottomDock>
        <RequirementCalculatorDialog
          conditionDialog={conditionDialog}
          onClose={() => setConditionDialog(null)}
        />
        {upgradeDialog && (
          <UpgradeDialog
            data={upgradeDialog}
            onClose={() => setUpgradeDialog(null)}
          />
        )}
        <BossBattleDialog />
        {queueDialog?.type === "character" && (
          <CharacterUpgrade onClose={() => setQueueDialog(null)} />
        )}
        {queueDialog?.type === "invitations" && (
          <BossInvitationsDialog onClose={() => setQueueDialog(null)} />
        )}
        {queueDialog?.type === "work" && (
          <WorkFarmDialog
            work={queueDialog.work}
            energy={queueDialog.work.energyCycle?.full}
            onClose={() => setQueueDialog(null)}
          />
        )}
        <TelegramLaunchScreen />
      </div>
    </ToastTargetContext.Provider>
  );
}
