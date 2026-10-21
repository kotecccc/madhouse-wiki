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
export function App() {
  const [upgradeDialog, setUpgradeDialog] = useState(null);
  const [conditionDialog, setConditionDialog] = useState(null);
  const [activeScreen, setActiveScreen] = useState(() =>
    window.location.hash === "#raids" ? "raids" : "floors",
  );

  useEffect(() => {
    const syncScreen = () =>
      setActiveScreen(window.location.hash === "#raids" ? "raids" : "floors");
    window.addEventListener("hashchange", syncScreen);
    return () => window.removeEventListener("hashchange", syncScreen);
  }, []);

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
            onCalculator={setConditionDialog}
            onUpgradeSelect={setUpgradeDialog}
          />
        </div>
        <div id="screen-raids" className="app-screen app-screen--raids">
          <RaidScheduleSection />
        </div>
      </main>
      <SiteFooter />
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
    </div>
  );
}
