import "./FloorGroup.css";
import { departmentById } from "../../../model/knowledge-base.js";
import { FloorWorkItem } from "../FloorWorkItem/FloorWorkItem.jsx";
import { RequirementCard } from "../RequirementCard/RequirementCard.jsx";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Title } from "../../../components/ui/Title/Title.jsx";
import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";

export function FloorGroup({ floor, viewMode, onCalculator, onUpgradeSelect, onRequirementSelect, focusedDepartmentId, registerDepartment }) {
  const works = floor.departmentIds
    .map((id) => departmentById[id])
    .filter(Boolean);
  const openingConditions = floor.openingConditions || (floor.code === "A" ? [] : works[0]?.openingConditions || []);
  const isFloorView = viewMode === "floors";
  const floorOpeningCard = isFloorView && openingConditions.length > 0 ? (
      <details className="floor-opening-disclosure floor-work-disclosure" open>
        <summary className="floor-work-summary floor-opening-summary">
          <ImageCard className="floor-opening-lock-card" size="var(--floor-code-card-size)" imageSize="var(--floor-code-image-size)" label="Условие открытия">
            <Icon type="lock" />
          </ImageCard>
          <CardTitle className="floor-opening-heading">Условия открытия {floor.code}</CardTitle>
        </summary>
        <div className="floor-work-expanded floor-opening-expanded">
          <ul className="floor-work-requirement-list floor-opening-requirements">
            {openingConditions.map((requirement, index) => (
              <RequirementCard key={`${floor.id}-unlock-${index}`} requirement={requirement} work={works[0]} onCalculator={onCalculator} onTargetSelect={onRequirementSelect} />
            ))}
          </ul>
        </div>
      </details>
    ) : openingConditions.length > 0 ? (
      <BaseCard variant="floor-data" className="floor-opening-card">
        <Title as="h4" className="floor-opening-title">Условия открытия</Title>
        <div className="floor-opening-rows">
          {openingConditions.map((requirement, index) => (
            <RequirementCard key={`${floor.id}-unlock-${index}`} embedded requirement={requirement} work={works[0]} onCalculator={onCalculator} onTargetSelect={onRequirementSelect} />
          ))}
        </div>
      </BaseCard>
    ) : null;
  return (
    <article className="floor-group" key={floor.id}>
      {!isFloorView && <Title as="h3" className="floor-heading">Этаж {floor.code}</Title>}
      {floorOpeningCard}
      <ul className="floor-work-list">
        {works.map((work) => (
          <FloorWorkItem
            key={work.id}
            work={work}
            onCalculator={onCalculator}
            onUpgradeSelect={onUpgradeSelect}
            onRequirementSelect={onRequirementSelect}
            focused={focusedDepartmentId === work.id}
            registerDepartment={registerDepartment}
            suppressRequirements={isFloorView && work.id === works[0]?.id}
          />
        ))}
      </ul>
    </article>
  );
}
