import "./FloorGroup.css";
import { departmentById } from "../../../model/knowledge-base.js";
import { FloorWorkItem } from "../FloorWorkItem/FloorWorkItem.jsx";
import { RequirementCard } from "../RequirementCard/RequirementCard.jsx";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Title } from "../../../components/ui/Title/Title.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { LockIndicator } from "../LockIndicator/LockIndicator.jsx";

const departmentCodeOrder = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

export function FloorGroup({
  floor,
  hideOpeningConditions = false,
  viewMode,
  onCalculator,
  onUpgradeSelect,
  onRequirementSelect,
  focusedDepartmentId,
  registerDepartment,
  departmentAvailability,
}) {
  const works = floor.departmentIds
    .map((id) => departmentById[id])
    .filter(Boolean)
    .sort((left, right) =>
      departmentCodeOrder.compare(String(left.code), String(right.code)),
    );
  const openingConditions = hideOpeningConditions
    ? []
    : floor.openingConditions ||
      (floor.code === "A" ? [] : works[0]?.openingConditions || []);
  const isFloorView = viewMode === "floors";
  const floorOpeningCard =
    isFloorView && openingConditions.length > 0 ? (
      <details className="floor-opening-disclosure floor-work-disclosure" open>
        <summary className="floor-work-summary floor-opening-summary">
          <CardTitle className="floor-opening-heading">
            <LockIndicator
              size="1em"
              label={`Условие открытия этажа ${floor.code}`}
            />
            <span>Условия открытия этажа </span>
            <span className="floor-opening-code">
              {floor.code}
            </span>
          </CardTitle>
        </summary>
        <div className="floor-work-expanded floor-opening-expanded">
          <ul className="floor-work-requirement-list floor-opening-requirements">
            {openingConditions.map((requirement, index) => (
              <RequirementCard
                key={`${floor.id}-unlock-${index}`}
                requirement={requirement}
                work={works[0]}
                onCalculator={onCalculator}
                onTargetSelect={onRequirementSelect}
              />
            ))}
          </ul>
        </div>
      </details>
    ) : openingConditions.length > 0 ? (
      <BaseCard variant="floor-data" className="floor-opening-card">
        <Title as="h4" className="floor-opening-title">
          Условия открытия
        </Title>
        <div className="floor-opening-rows">
          {openingConditions.map((requirement, index) => (
            <RequirementCard
              key={`${floor.id}-unlock-${index}`}
              embedded
              requirement={requirement}
              work={works[0]}
              onCalculator={onCalculator}
              onTargetSelect={onRequirementSelect}
            />
          ))}
        </div>
      </BaseCard>
    ) : null;
  return (
    <article className="floor-group" key={floor.id}>
      {!isFloorView && (
        <Title as="h3" className="floor-heading">
          Этаж {floor.code}
        </Title>
      )}
      {floorOpeningCard}
      {works.length === 0 && (
        <p>Описания отделов этого этажа пока отсутствуют в справочнике.</p>
      )}
      <ul className="floor-work-list">
        {works.map((work) => (
          <FloorWorkItem
            key={work.id}
            work={work}
            locked={departmentAvailability?.[work.code] === false}
            onCalculator={onCalculator}
            onUpgradeSelect={onUpgradeSelect}
            onRequirementSelect={onRequirementSelect}
            focused={focusedDepartmentId === work.id}
            registerDepartment={registerDepartment}
            suppressRequirements={
              departmentAvailability?.[work.code] === true ||
              (isFloorView && work.id === works[0]?.id)
            }
          />
        ))}
      </ul>
    </article>
  );
}
