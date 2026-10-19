import { ContentSection } from "../../../components/ui/ContentSection/ContentSection.jsx";
import "./FloorsSection.css";
import { orderedFloors } from "../../../model/knowledge-base.js";
import { FloorGroup } from "../FloorGroup/FloorGroup.jsx";
export function FloorsSection({ onCalculator, onUpgradeSelect }) {
  return (
    <ContentSection
      className="floors-section"
      id="floors"
      aria-labelledby="floors-title"
    >
      <h2 className="sr-only" id="floors-title">
        Этажи и работёнки
      </h2>
      <div className="floor-grid" aria-live="polite">
        {orderedFloors.map((f) => (
          <FloorGroup
            key={f.id}
            floor={f}
            onCalculator={onCalculator}
            onUpgradeSelect={onUpgradeSelect}
          />
        ))}
      </div>
    </ContentSection>
  );
}
