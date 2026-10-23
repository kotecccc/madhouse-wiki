import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import { BaseCard } from "../../src/components/ui/BaseCard/BaseCard.jsx";
import { CardTitle } from "../../src/components/ui/CardTitle/CardTitle.jsx";
import { BusinessRequirementContent } from "../../src/features/businesses/BusinessRequirementDialog/BusinessRequirementDialog.jsx";
import { knowledgeBase } from "virtual:madhouse-catalogue";
import { businessUpgradeCardGroups } from "./inline-business-card-groups.mjs";
import "../../src/styles/tokens.css";
import "../../src/styles/global.css";
import "./inline-business-card-preview.css";

const groups = businessUpgradeCardGroups(knowledgeBase);

function App() {
  useEffect(() => {
    Promise.all([
      document.fonts?.ready,
      ...Array.from(document.images, (image) =>
        image.decode().catch(() => null),
      ),
    ]).then(() =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          document.documentElement.dataset.businessCardsReady = "true";
        }),
      ),
    );
  }, []);

  return (
    <main>
      {groups.map(({ key, business, requirement }) => (
        <BaseCard
          as="section"
          className="inline-business-upgrade-group"
          data-business-upgrade-group={key}
          key={key}
          variant="floor-data"
        >
          <CardTitle as="h1">
            {`Что собирать для «${business.title || "Бизнес"}», уровень ${requirement.requiredLevel}?`}
          </CardTitle>
          <BusinessRequirementContent
            business={business}
            requirement={requirement}
            imageLoading="eager"
          />
        </BaseCard>
      ))}
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
