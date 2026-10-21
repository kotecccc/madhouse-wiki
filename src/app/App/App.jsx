import { knowledgeBase as kb } from "virtual:madhouse-catalogue";
import "./App.css";
import { useEffect, useState } from "react";
import { SiteHeader } from "../../components/layout/SiteHeader/SiteHeader.jsx";
import { SiteFooter } from "../../components/layout/SiteFooter/SiteFooter.jsx";
import { FloorsSection } from "../../features/floors/FloorsSection/FloorsSection.jsx";
import { RequirementCalculatorDialog } from "../../features/calculator/RequirementCalculatorDialog/RequirementCalculatorDialog.jsx";
import { UpgradeDialog } from "../../features/businesses/UpgradeDialog/UpgradeDialog.jsx";
import { RaidScheduleSection } from "../../features/raids/RaidScheduleSection/RaidScheduleSection.jsx";
import { TelegramLaunchScreen } from "../../features/telegram/TelegramLaunchScreen/TelegramLaunchScreen.jsx";
import { MobileNavigation } from "../../components/layout/MobileNavigation/MobileNavigation.jsx";
import { AnalyticsExperience } from "../../features/analytics/AnalyticsExperience/AnalyticsExperience.jsx";
import { FeedbackWidget } from "../../features/support/FeedbackWidget/FeedbackWidget.jsx";
import { trackProductEvent } from "../../features/analytics/analytics-client.js";
import { useFloorAvailability } from "../../features/floors/useFloorAvailability.js";
export function App() {
  const floorAvailability = useFloorAvailability();
  const [upgradeDialog, setUpgradeDialog] = useState(null);
  const [conditionDialog, setConditionDialog] = useState(null);
  const [activeScreen, setActiveScreen] = useState(() => {
    if (typeof window === "undefined") return "floors";
    const screen = window.location.hash.slice(1);
    return ["floors", "raids"].includes(screen) ? screen : "floors";
  });
  const [privacySettingsOpen, setPrivacySettingsOpen] = useState(false);

  useEffect(() => {
    const syncScreen = () => {
      const screen = window.location.hash.slice(1);
      setActiveScreen(["floors", "raids"].includes(screen) ? screen : "floors");
    };
    window.addEventListener("hashchange", syncScreen);
    return () => window.removeEventListener("hashchange", syncScreen);
  }, []);

  useEffect(() => {
    trackProductEvent("screen_view", {
      section: activeScreen,
      feature: activeScreen === "raids" ? "raid_schedule" : "floor_catalogue",
    });
  }, [activeScreen]);

  function changeScreen(screen) {
    setActiveScreen(screen);
    window.history.replaceState(null, "", `#${screen}`);
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  return (
    <div className="site-shell">
      <SiteHeader />
      <main id="top" className={`app-content app-content--${activeScreen}`}>
        <div id="screen-floors" className="app-screen app-screen--floors">
          {kb.floors.length === 0 && (
            <p role="status">Справочник ещё не заполнен.</p>
          )}
          <FloorsSection
            {...floorAvailability}
            onCalculator={setConditionDialog}
            onUpgradeSelect={setUpgradeDialog}
          />
        </div>
        <div id="screen-raids" className="app-screen app-screen--raids">
          <RaidScheduleSection availability={floorAvailability.availability} />
        </div>
      </main>
      <SiteFooter onPrivacySettings={() => setPrivacySettingsOpen(true)} />
      <MobileNavigation
        activeScreen={activeScreen}
        onScreenChange={changeScreen}
      />
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
      <TelegramLaunchScreen />
      <AnalyticsExperience
        settingsOpen={privacySettingsOpen}
        onClose={() => setPrivacySettingsOpen(false)}
      />
      <FeedbackWidget
        screen={activeScreen}
        onOpenPrivacy={() => setPrivacySettingsOpen(true)}
      />
    </div>
  );
}
