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
import {
  bossBattle,
  bossInvitations,
  connectBattleSession,
} from "../../features/bosses/BossBattle/boss-battle-session.js";
import { CharacterUpgrade } from "../../features/overview/CharacterUpgrade/CharacterUpgrade.jsx";
import { WorkFarmDialog } from "../../features/works/WorkCard/WorkFarmDialog.jsx";
import { WorkCalculatorDialog } from "../../features/works/WorkCard/WorkCalculatorDialog.jsx";
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
import { Button } from "../../components/ui/Button/Button.jsx";
import { BaseCard } from "../../components/ui/BaseCard/BaseCard.jsx";
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

import {
  pageFromPath,
  screenFromHash,
  screenFromLocation,
  screenUrl,
} from "./app-screen.js";
import { usePullRefresh } from "./usePullRefresh.js";
import { PullRefresh } from "../../components/ui/PullRefresh/PullRefresh.jsx";
import {
  PageHostContext,
  subscribePages,
  getPages,
  refreshTopPage,
  closeAllPages,
} from "../../components/ui/Modal/page-context.js";

export function App() {
  const [pageHost, setPageHost] = useState(null);
  const [bossActionsTarget, setBossActionsTarget] = useState(null);
  const [bossAttackTarget, setBossAttackTarget] = useState(null);
  const pages = useSyncExternalStore(subscribePages, getPages, getPages);
  const battleState = useSyncExternalStore(
    bossBattle.subscribe,
    bossBattle.getSnapshot,
    bossBattle.getSnapshot,
  );
  const currentPage = pages.at(-1);
  const bossPage = currentPage?.kind === "boss";
  const otherActiveBattle = Boolean(
    battleState.previewBoss && battleState.battle?.status === "active",
  );
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
  const [sessionStatus, setSessionStatus] = useState(() => {
    const session = readSession();
    return session.wikiSessionReady ? "ready" : session.status;
  });
  const authenticated = sessionStatus === "ready";
  const [activeScreen, setActiveScreen] = useState(() =>
    typeof window === "undefined"
      ? "overview"
      : screenFromLocation(window.location.pathname, window.location.hash),
  );
  const [routePath, setRoutePath] = useState(() =>
    typeof window === "undefined" ? "/" : window.location.pathname,
  );
  const [routeWork, setRouteWork] = useState(null);
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
  const [inventoryRefresh, setInventoryRefresh] = useState(0);
  const [workCollectionNotice, setWorkCollectionNotice] = useState(null);
  const [sessionGeneration, setSessionGeneration] = useState(0);
  const onFriendCompleted = useCallback(
    () => setFriendsRefresh((value) => value + 1),
    [],
  );
  const onWorkCollectionCompleted = useCallback((run) => {
    setWorkCollectionNotice(run.title || "Работёнка");
  }, []);
  const actionQueue = useActionQueue(
    authenticated,
    sessionGeneration,
    onFriendCompleted,
    onWorkCollectionCompleted,
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
      if (event.cleared) {
        setInventoryResponses({});
        setInventoryDirty([]);
      } else if (inventoryPathsSet.current.has(event.path) && event.data) {
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
    if (visibleScreen === "inventory")
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
  }, [
    authenticated,
    profileState.profile?.playerLevel,
    sessionGeneration,
    visibleScreen,
  ]);
  const inventoryCount = inventoryCategoryOptions(
    inventoryResponses,
    kb.inventoryItems || [],
  ).reduce((sum, option) => sum + (option.count || 0), 0);
  const pull = usePullRefresh({
    regionRef: scrollRegionRef,
    enabled: true,
    onRefresh: async () => {
      if (await refreshTopPage()) return;
      if (visibleScreen === "queue") {
        if (authenticated)
          await getSessionJson("/api/automation/state", {
            fresh: true,
            revalidate: false,
          });
        return;
      }
      if (visibleScreen === "friends") {
        setFriendsRefresh((value) => value + 1);
        return;
      }
      if (visibleScreen === "inventory") {
        setInventoryRefresh((value) => value + 1);
        return;
      }
      if (visibleScreen === "raids") {
        await Promise.allSettled([
          raidSchedule.refresh(),
          ...(authenticated ? [bossInvitations.refresh()] : []),
        ]);
        return;
      }
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
    const syncSession = () => {
      const session = readSession();
      setSessionStatus(session.wikiSessionReady ? "ready" : session.status);
    };
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
      if (window.location.hash === "#queue")
        window.history.replaceState(
          window.history.state,
          "",
          screenUrl("queue", window.location.search),
        );
      const legacy = /^#(boss|work)\/(\d+)$/.exec(window.location.hash);
      if (legacy && pageFromPath(`/${legacy[1]}/${legacy[2]}`))
        window.history.replaceState(
          window.history.state,
          "",
          `/${legacy[1]}/${legacy[2]}${window.location.search}`,
        );
      const page = pageFromPath(window.location.pathname);
      if (page && window.location.pathname.endsWith("/"))
        window.history.replaceState(
          window.history.state,
          "",
          `/${page.kind}/${page.id}${window.location.search}${window.location.hash}`,
        );
      const next = screenFromLocation(
        window.location.pathname,
        window.location.hash,
      );
      setActiveScreen(next);
      setRoutePath(window.location.pathname);
      if (window.location.hash === "#overview")
        window.history.replaceState(
          window.history.state,
          "",
          `${window.location.pathname}${window.location.search}`,
        );
    };
    syncScreen();
    window.addEventListener("hashchange", syncScreen);
    window.addEventListener("popstate", syncScreen);
    return () => {
      window.removeEventListener("hashchange", syncScreen);
      window.removeEventListener("popstate", syncScreen);
    };
  }, []);

  useEffect(() => {
    const route = pageFromPath(routePath);
    if (!route) return;
    if (route.kind === "work") {
      const work = kb.works.find(
        (item) =>
          Number(
            item.workId ??
              item.numericId ??
              item.apiId ??
              String(item.id).split(":").at(-1),
          ) === route.id,
      );
      if (work) setRouteWork(work);
      return;
    }
    if (!authenticated) return;
    if (route.kind === "battle") return;
    const boss = kb.bosses.find(
      (item) => Number(item.numericId ?? item.apiId) === route.id,
    );
    if (!boss) return;
    let cancelled = false;
    void connectBattleSession().then(() => {
      if (!cancelled && window.location.pathname === routePath)
        void bossBattle.open(boss);
    });
    return () => {
      cancelled = true;
    };
  }, [routePath, authenticated]);

  useEffect(() => {
    const route = pageFromPath(routePath);
    if (
      authenticated &&
      route?.kind === "battle" &&
      String(battleState.battle?.id ?? "") === route.id &&
      battleState.boss &&
      !battleState.visible
    )
      void bossBattle.open(battleState.boss, { refresh: false });
  }, [
    routePath,
    authenticated,
    battleState.battle?.id,
    battleState.boss,
    battleState.visible,
  ]);

  function changeScreen(screen) {
    closeAllPages();
    const next = screenFromHash(`#${screen}`);
    setActiveScreen(next);
    window.history.replaceState(
      null,
      "",
      screenUrl(next, window.location.search),
    );
    setRoutePath(next === "queue" ? "/queue" : "/");
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
    <PageHostContext.Provider value={pageHost}>
      <ToastTargetContext.Provider value={toastTarget}>
        <div className="site-shell">
          <div className="site-header-group">
            <SiteHeader
              onHome={() => changeScreen("overview")}
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
            <main
              id="top"
              className={`app-content app-content--${visibleScreen}${pages.length ? " app-content--subpage" : ""}`}
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
                    queueFocus={
                      queueFocus?.kind === "floor" ? queueFocus : null
                    }
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
                    presence={actionQueue.presence}
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
                    refreshGeneration={inventoryRefresh}
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
            <div ref={setPageHost} className="app-subpage-host" />
            <div hidden={pages.length > 0}>
              <SiteFooter>
                <FeedbackWidget screen={activeScreen} />
              </SiteFooter>
            </div>
          </div>
          {workCollectionNotice && (
            <Toast
              floating
              success
              title="Части набора собраны"
              onDismiss={() => setWorkCollectionNotice(null)}
            >
              {workCollectionNotice}
            </Toast>
          )}
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
            <ActiveBattleControl hideIndicators={bossPage}>
              {bossPage ? (
                <div className="boss-page-actions">
                  <BaseCard variant="glass-nav-circle">
                    <Button
                      variant="nav-tab"
                      size="lg"
                      icon="arrow-left"
                      iconSize="large"
                      iconOnly
                      aria-label="Назад"
                      onClick={currentPage.back}
                    />
                  </BaseCard>
                  <BaseCard
                    variant="glass-nav"
                    ref={setBossActionsTarget}
                    className="boss-page-actions-target"
                  />
                  {otherActiveBattle ? (
                    <div
                      ref={setBossAttackTarget}
                      className="boss-page-actions-target"
                    />
                  ) : (
                    <BaseCard
                      variant="glass-nav"
                      ref={setBossAttackTarget}
                      className="boss-page-actions-target"
                    />
                  )}
                </div>
              ) : (
                <MobileNavigation
                  activeScreen={visibleScreen}
                  inventoryCount={inventoryCount}
                  authenticated={authenticated}
                  onScreenChange={changeScreen}
                />
              )}
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
          <BossBattleDialog
            actionsTarget={bossActionsTarget}
            attackTarget={bossAttackTarget}
          />
          {routeWork && (
            <WorkCalculatorDialog
              work={routeWork}
              energy={
                kb.departments.find(
                  (department) => department.id === routeWork.departmentId,
                )?.energyCycle?.full
              }
              visible
              onClose={() => setRouteWork(null)}
            />
          )}
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
    </PageHostContext.Provider>
  );
}
