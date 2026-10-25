import { BossBattleDialog } from "../../features/bosses/BossBattle/BossBattleDialog.jsx";
import { ActiveBattleControl } from "../../features/combat/ActiveBattleDock/ActiveBattleDock.jsx";
import { BottomDock } from "../../components/layout/BottomDock/BottomDock.jsx";
import { knowledgeBase as kb } from "virtual:madhouse-catalogue";
import "./App.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { SiteHeader } from "../../components/layout/SiteHeader/SiteHeader.jsx";
import { SiteFooter } from "../../components/layout/SiteFooter/SiteFooter.jsx";
import { FloorsSection } from "../../features/floors/FloorsSection/FloorsSection.jsx";
import { RequirementCalculatorDialog } from "../../features/calculator/RequirementCalculatorDialog/RequirementCalculatorDialog.jsx";
import { UpgradeDialog } from "../../features/businesses/UpgradeDialog/UpgradeDialog.jsx";
import { RaidScheduleSection } from "../../features/raids/RaidScheduleSection/RaidScheduleSection.jsx";
import { TelegramLaunchScreen } from "../../features/telegram/TelegramLaunchScreen/TelegramLaunchScreen.jsx";
import { MobileNavigation } from "../../components/layout/MobileNavigation/MobileNavigation.jsx";
import { FeedbackWidget } from "../../features/support/FeedbackWidget/FeedbackWidget.jsx";
import { useFloorAvailability } from "../../features/floors/useFloorAvailability.js";
import { readSession, subscribeSession } from "../../../shared/auth-session.js";
import { AUTH_RESTORE_SETTLED_EVENT } from "../../../shared/auth-session.js";
import { usePlayerProfile } from "../../features/auth/usePlayerProfile.js";
import { OverviewSection } from "../../features/overview/OverviewSection/OverviewSection.jsx";
import { useRaidSchedule } from "../../features/raids/useRaidSchedule.js";

function screenFromHash(authenticated) {
  const screen = window.location.hash.slice(1);
  if (screen === "overview") return authenticated ? "overview" : "floors";
  if (["floors", "raids"].includes(screen)) return screen;
  return authenticated ? "overview" : "floors";
}

export function App() {
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
  const profileLoading =
    authenticated && ["idle", "loading"].includes(profileState.status);
  const [activeScreen, setActiveScreen] = useState(() =>
    typeof window === "undefined"
      ? "floors"
      : screenFromHash(readSession().status === "ready"),
  );
  const explicitScreen = useRef(
    typeof window !== "undefined" &&
      (["floors", "raids"].includes(window.location.hash.slice(1)) ||
        (window.location.hash.slice(1) === "overview" &&
          readSession().status === "ready")),
  );
  const [departmentState, setDepartmentState] = useState(null);
  const [floorFocusCode, setFloorFocusCode] = useState(null);

  useEffect(() => {
    let previousStatus = readSession().status;
    const syncSession = () => {
      const next = readSession().status;
      setSessionStatus(next);
      if (
        previousStatus !== "ready" &&
        next === "ready" &&
        !explicitScreen.current
      ) {
        setActiveScreen("overview");
        window.history.replaceState(null, "", "#overview");
      } else if (previousStatus === "ready" && next !== "ready") {
        setDepartmentState(null);
        if (activeScreen === "overview") {
          setActiveScreen("floors");
          window.history.replaceState(null, "", "#floors");
        }
      }
      previousStatus = next;
    };
    const unsubscribe = subscribeSession(syncSession);
    const restoreSettled = () => syncSession();
    const timer = window.setInterval(syncSession, 1000);
    window.addEventListener(AUTH_RESTORE_SETTLED_EVENT, restoreSettled);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
      window.removeEventListener(AUTH_RESTORE_SETTLED_EVENT, restoreSettled);
    };
  }, [activeScreen]);

  useEffect(() => {
    const syncScreen = () => {
      const requested = window.location.hash.slice(1);
      const isAuthenticated = readSession().status === "ready";
      explicitScreen.current =
        ["floors", "raids"].includes(requested) ||
        (requested === "overview" && isAuthenticated);
      setActiveScreen(screenFromHash(isAuthenticated));
      if (requested === "overview" && !isAuthenticated)
        window.history.replaceState(null, "", "#floors");
    };
    window.addEventListener("hashchange", syncScreen);
    return () => window.removeEventListener("hashchange", syncScreen);
  }, []);

  function changeScreen(screen) {
    const next = screen === "overview" && !authenticated ? "floors" : screen;
    explicitScreen.current = true;
    setActiveScreen(next);
    window.history.replaceState(null, "", `#${next}`);
    scrollRegionRef.current?.scrollTo({ top: 0, behavior: "instant" });
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  const onOpenFloors = (code) => {
    setFloorFocusCode(code || null);
    changeScreen("floors");
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
        showDivider={!profileLoading}
        loading={
          profileState.status === "loading" ||
          floorAvailability.status === "loading" ||
          raidSchedule.status === "loading"
        }
      />
      <div className="app-scroll-region" ref={scrollRegionRef} data-page-scroll>
        <main
          id="top"
          className={`app-content app-content--${activeScreen}${profileLoading ? " app-content--profile-loading" : ""}`}
        >
          {authenticated && (
            <div
              id="screen-overview"
              className="app-screen app-screen--overview"
            >
              <OverviewSection
                profileState={profileState}
                floorAvailability={floorAvailability}
                departmentState={departmentState}
                schedule={raidSchedule}
                onOpenFloors={onOpenFloors}
                onOpenRaids={onOpenRaids}
                onRetryFloors={floorAvailability.retry}
              />
            </div>
          )}
          <div id="screen-floors" className="app-screen app-screen--floors">
            {kb.floors.length === 0 && (
              <p role="status">Справочник ещё не заполнен.</p>
            )}
            <FloorsSection
              {...floorAvailability}
              isAuthenticated={authenticated}
              onCalculator={setConditionDialog}
              onUpgradeSelect={setUpgradeDialog}
              onDepartmentState={onDepartmentState}
              selectedFloorCode={floorFocusCode}
            />
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
        <MobileNavigation
          activeScreen={activeScreen}
          onScreenChange={changeScreen}
          isAuthenticated={authenticated}
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
