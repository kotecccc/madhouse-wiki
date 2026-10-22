import { ContentSection } from "../../../components/ui/ContentSection/ContentSection.jsx";
import "./BossesSection.css";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { useState } from "react";
import { bossFloors, getBossGroups } from "../../../model/knowledge-base.js";
import { BossCard } from "../BossCard/BossCard.jsx";
import { Title } from "../../../components/ui/Title/Title.jsx";
export function BossesSection({ compact = false }) {
  const [floorPage, setFloorPage] = useState(0);
  const floorCode = bossFloors[floorPage] || "unknown";
  const bossGroups = getBossGroups(floorCode);
  return (
    <ContentSection
      className={`bosses-section${compact ? " bosses-section--tab" : ""}`}
      id="bosses"
      aria-labelledby="bosses-title"
    >
      <div className={compact ? "sr-only" : "section-heading"}>
        <div>
          <div className="eyebrow">
            <span className="eyebrow-line" /> БЕСТИАРИЙ
          </div>
          <Title as="h2" id="bosses-title">
            Боссы этажей
          </Title>
        </div>
      </div>
      <div className="boss-tools">
        <Button
          className="floor-page-button"
          type="button"
          aria-label="Предыдущий этаж"
          disabled={floorPage === 0}
          onClick={() => setFloorPage((p) => Math.max(0, p - 1))}
        >
          ←
        </Button>
        <span className="boss-count" aria-live="polite">
          {floorCode === "unknown" ? "Этаж не указан" : `Этаж ${floorCode}`} •{" "}
          {bossFloors.length ? floorPage + 1 : 0} / {bossFloors.length}
        </span>
        <Button
          className="floor-page-button"
          type="button"
          aria-label="Следующий этаж"
          disabled={floorPage >= bossFloors.length - 1}
          onClick={() =>
            setFloorPage((p) => Math.min(bossFloors.length - 1, p + 1))
          }
        >
          →
        </Button>
      </div>
      <div className="boss-grid" aria-live="polite">
        {Object.entries(bossGroups).map(([zone, bosses]) => (
          <section className="boss-group" key={zone}>
            <Title as="h3">{zone}</Title>
            <div className="boss-group-cards">
              {bosses.map((b) => (
                <BossCard key={b.id} boss={b} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </ContentSection>
  );
}
