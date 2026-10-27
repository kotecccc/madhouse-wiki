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
import { BorderLoader } from "../../components/ui/BorderLoader/BorderLoader.jsx";
import { CardDescription } from "../../components/ui/CardDescription/CardDescription.jsx";
import { SiteHeader } from "../../components/layout/SiteHeader/SiteHeader.jsx";
import { SiteFooter } from "../../components/layout/SiteFooter/SiteFooter.jsx";
import { FloorsSection } from "../../features/floors/FloorsSection/FloorsSection.jsx";
import { RequirementCalculatorDialog } from "../../features/calculator/RequirementCalculatorDialog/RequirementCalculatorDialog.jsx";
import { UpgradeDialog } from "../../features/businesses/UpgradeDialog/UpgradeDialog.jsx";
import { RaidScheduleSection } from "../../features/raids/RaidScheduleSection/RaidScheduleSection.jsx";
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
import { raidSubscriptions } from "../../features/bosses/BossBattle/boss-battle-session.js";

import { screenFromHash } from "./app-screen.js";
import { isPullReady } from "./pull-refresh.js";

export function App() {
  const [toastTarget, setToastTarget] = useState(null);
  const refreshing = useSyncExternalStore(
    subscribeSessionData,
    readSessionRefreshState,
    () => false,
  );
  const scrollRegionRef = useRef(null);
  const floorAvailability = useFloorAvailability();
  const profileState = usePlayerProfile();
  const raidSchedule = useRaidSchedule();
  const [upgradeDialog, setUpgradeDialog] = useState(null);
  const [conditionDialog, setConditionDialog] = useState(null);
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
  const [floorFocusCode, setFloorFocusCode] = useState(null);
  const [visibleFloorCode, setVisibleFloorCode] = useState(null);
  const [inventoryRefresh, setInventoryRefresh] = useState(0);
  const [friendsRefresh, setFriendsRefresh] = useState(0);
  const [friendsLoading, setFriendsLoading] = useState(false);
  const lastPull = useRef(0);
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
  const [pullReady, setPullReady] = useState(false);
  const pullStart = useRef(null);

  function startPull(event) {
    pullStart.current = null;
    setPullReady(false);
    if (
      event.touches.length !== 1 ||
      scrollRegionRef.current?.scrollTop > 0 ||
      event.target.closest("button, input, textarea, select, dialog, a")
    )
      return;
    pullStart.current = {
      x: event.touches[0].clientX,
      y: event.touches[0].clientY,
      ready: false,
    };
  }
  function movePull(event) {
    const start = pullStart.current;
    if (!start || event.touches.length !== 1) return;
    start.ready = isPullReady({
      startX: start.x,
      startY: start.y,
      x: event.touches[0].clientX,
      y: event.touches[0].clientY,
      scrollTop: scrollRegionRef.current?.scrollTop,
    });
    setPullReady(start.ready);
  }
  function endPull(event) {
    if (event.touches.length > 0) {
      pullStart.current = null;
      setPullReady(false);
      return;
    }
    const ready = pullStart.current?.ready;
    pullStart.current = null;
    setPullReady(false);
    if (
      !ready ||
      Date.now() - lastPull.current < 10000 ||
      refreshing ||
      friendsLoading
    )
      return;
    lastPull.current = Date.now();
    if (visibleScreen === "friends") {
      setFriendsRefresh((value) => value + 1);
    } else if (visibleScreen === "inventory") {
      setInventoryRefresh((value) => value + 1);
    } else if (visibleScreen === "raids") {
      raidSchedule.retry();
      if (authenticated) raidSubscriptions.watch(true);
    } else {
      floorAvailability.retry();
      if (authenticated) {
        const paths = new Set(["/api/me", "/api/floors"]);
        for (const code of [visibleFloorCode, departmentState?.code])
          if (code) paths.add(`/api/floors/${encodeURIComponent(code)}/info`);
        for (const path of paths)
          void getSessionJson(path, {
            fresh: true,
            serverRefresh: "live",
          }).catch(() => {});
      }
    }
  }

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
          onTouchStart={startPull}
          onTouchMove={movePull}
          onTouchEnd={endPull}
          onTouchCancel={() => {
            pullStart.current = null;
            setPullReady(false);
          }}
        >
          {(refreshing || (visibleScreen === "friends" && friendsLoading)) && (
            <BorderLoader label="Обновление данных" />
          )}
          {pullReady && (
            <CardDescription role="status">
              Отпустите, чтобы обновить
            </CardDescription>
          )}
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
                  onVisibleFloorChange={setVisibleFloorCode}
                />
              </div>
            </div>
            <div id="screen-raids" className="app-screen app-screen--raids">
              <RaidScheduleSection
                authenticated={authenticated}
                active={visibleScreen === "raids"}
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
                  onRefreshState={setFriendsLoading}
                  onNotice={setInventoryNotice}
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
                  refreshGeneration={inventoryRefresh}
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
        <TelegramLaunchScreen />
      </div>
    </ToastTargetContext.Provider>
  );
}
