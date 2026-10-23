import { createRoot } from "react-dom/client";
import { useEffect } from "react";
import { BossCardView } from "../../src/features/bosses/BossCard/BossCardView.jsx";
import { getBossCardVariantProps } from "../../src/features/bosses/BossCard/boss-card-variants.js";
import { CardDescription } from "../../src/components/ui/CardDescription/CardDescription.jsx";
import { knowledgeBase } from "virtual:madhouse-catalogue";
import { departmentById } from "../../src/model/knowledge-base.js";
import { bossDisplayFields } from "../../src/lib/card-display-fields.js";
import { bossOpeningGroups } from "./boss-opening-groups.mjs";
import "../../src/styles/tokens.css";
import "./inline-boss-card-preview.css";

const cardSettings = getBossCardVariantProps("boss-business");
const groups = bossOpeningGroups(knowledgeBase);

function BossRequirementCard({ boss, condition }) {
  return (
    <BossCardView
      boss={boss}
      variant="floor-data"
      {...cardSettings}
      displayFields={bossDisplayFields(
        boss,
        departmentById[boss.departmentId] || {},
      )}
      showDropList={false}
      action={false}
      imageLoading="eager"
    >
      <CardDescription size={cardSettings.infoSize}>
        {condition.label || `Убить ${boss.name} ${condition.required} раз`}
      </CardDescription>
    </BossCardView>
  );
}

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
          document.documentElement.dataset.bossCardsReady = "true";
        }),
      ),
    );
  }, []);

  return (
    <main>
      {groups.map((group) => (
        <section
          className="inline-boss-opening-group"
          data-boss-opening-group={group.key}
          key={group.key}
        >
          {group.bosses.map(({ boss, condition }, index) => (
            <BossRequirementCard
              key={`${boss.id}-${index}`}
              boss={boss}
              condition={condition}
            />
          ))}
        </section>
      ))}
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
