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
} from "../../../shared/session-api.js";
import { SiteHeader } from "../../components/layout/SiteHeader/SiteHeader.jsx";
import { SiteFooter } from "../../components/layout/SiteFooter/SiteFooter.jsx";
import { FloorsSection } from "../../features/floors/FloorsSection/FloorsSection.jsx";
import { RequirementCalculatorDialog } from "../../features/calculator/RequirementCalculatorDialog/RequirementCalculatorDialog.jsx";
import { UpgradeDialog } from "../../features/businesses/UpgradeDialog/UpgradeDialog.jsx";
import { RaidScheduleSection } from "../../features/raids/RaidScheduleSection/RaidScheduleSection.jsx";
import { TelegramLaunchScreen } from "../../features/telegram/TelegramLaunchScreen/TelegramLaunchScreen.jsx";
import { MobileNavigation } from "../../components/layout/MobileNavigation/MobileNavigation.jsx";
import { GameHealthWarning } from "../../components/layout/BottomDock/GameHealthWarning.jsx";
import { FeedbackWidget } from "../../features/support/FeedbackWidget/FeedbackWidget.jsx";
import { useFloorAvailability } from "../../features/floors/useFloorAvailability.js";
import { readSession, subscribeSession } from "../../../shared/auth-session.js";
import { AUTH_RESTORE_SETTLED_EVENT } from "../../../shared/auth-session.js";
import { usePlayerProfile } from "../../features/auth/usePlayerProfile.js";
import { OverviewSection } from "../../features/overview/OverviewSection/OverviewSection.jsx";
import { useRaidSchedule } from "../../features/raids/useRaidSchedule.js";

import { screenFromHash } from "./app-screen.js";

export function App() {
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
  const [departmentState, setDepartmentState] = useState(null);
  const [floorContentLoading, setFloorContentLoading] = useState(false);
  const [floorFocusCode, setFloorFocusCode] = useState(null);

  useEffect(() => {
    const syncSession = () => setSessionStatus(readSession().status);
    const unsubscribe = subscribeSession(syncSession);
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
    <div className="site-shell">
      <SiteHeader
        loading={
          refreshing ||
          profileState.status === "loading" ||
          floorAvailability.status === "loading" ||
          floorContentLoading ||
          raidSchedule.status === "loading"
        }
      />
      <div className="app-scroll-region" ref={scrollRegionRef} data-page-scroll>
        <main id="top" className={`app-content app-content--${activeScreen}`}>
          <div id="screen-overview" className="app-screen app-screen--overview">
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
              />
            </div>
          </div>
          <div id="screen-raids" className="app-screen app-screen--raids">
            <RaidScheduleSection
              availability={floorAvailability.availability}
              state={raidSchedule}
              onRetry={raidSchedule.retry}
            />
          </div>
        </main>
        <SiteFooter>
          <FeedbackWidget screen={activeScreen} />
        </SiteFooter>
      </div>
      <BottomDock>
        <ActiveBattleControl />
        <GameHealthWarning />
        <MobileNavigation
          activeScreen={activeScreen}
          onScreenChange={changeScreen}
        />
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
  );
}
