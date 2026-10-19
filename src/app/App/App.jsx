import "./App.css";
import { useState } from "react";
import { SiteHeader } from "../../components/layout/SiteHeader/SiteHeader.jsx";
import { SiteFooter } from "../../components/layout/SiteFooter/SiteFooter.jsx";
import { FloorsSection } from "../../features/floors/FloorsSection/FloorsSection.jsx";
import { BossesSection } from "../../features/bosses/BossesSection/BossesSection.jsx";
import { EnergyCalculator } from "../../features/calculator/EnergyCalculator/EnergyCalculator.jsx";
import { RequirementCalculatorDialog } from "../../features/calculator/RequirementCalculatorDialog/RequirementCalculatorDialog.jsx";
import { UpgradeDialog } from "../../features/businesses/UpgradeDialog/UpgradeDialog.jsx";
export function App() {
  const [upgradeDialog, setUpgradeDialog] = useState(null);
  const [conditionDialog, setConditionDialog] = useState(null);
  return (
    <div className="site-shell">
      <SiteHeader />
      <main id="top">
        <FloorsSection
          onCalculator={setConditionDialog}
          onUpgradeSelect={setUpgradeDialog}
        />
        <BossesSection />
        <EnergyCalculator />
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
    </div>
  );
}
