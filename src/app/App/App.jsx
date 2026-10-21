import { knowledgeBase as kb } from "virtual:madhouse-catalogue";
import "./App.css";
import { useState } from "react";
import { SiteHeader } from "../../components/layout/SiteHeader/SiteHeader.jsx";
import { SiteFooter } from "../../components/layout/SiteFooter/SiteFooter.jsx";
import { FloorsSection } from "../../features/floors/FloorsSection/FloorsSection.jsx";
import { RequirementCalculatorDialog } from "../../features/calculator/RequirementCalculatorDialog/RequirementCalculatorDialog.jsx";
import { UpgradeDialog } from "../../features/businesses/UpgradeDialog/UpgradeDialog.jsx";
import { RaidScheduleSection } from "../../features/raids/RaidScheduleSection/RaidScheduleSection.jsx";
import { TelegramLaunchScreen } from "../../features/telegram/TelegramLaunchScreen/TelegramLaunchScreen.jsx";
export function App() {
  const [upgradeDialog, setUpgradeDialog] = useState(null);
  const [conditionDialog, setConditionDialog] = useState(null);
  return (
    <div className="site-shell">
      <SiteHeader />
      <main id="top">
        {kb.floors.length === 0 && (
          <p role="status">Справочник ещё не заполнен.</p>
        )}
        <FloorsSection
          onCalculator={setConditionDialog}
          onUpgradeSelect={setUpgradeDialog}
        />
        <RaidScheduleSection />
      </main>
      <SiteFooter />
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
