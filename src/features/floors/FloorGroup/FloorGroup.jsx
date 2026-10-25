import { FloorDepartmentContent } from "../FloorDepartmentContent/FloorDepartmentContent.jsx";
import { EditableValue } from "../../../components/ui/CardEditing/EditableValue.jsx";
import "./FloorGroup.css";
import { departmentById } from "../../../model/knowledge-base.js";
import { FloorWorkItem } from "../FloorWorkItem/FloorWorkItem.jsx";
import { RequirementCard } from "../RequirementCard/RequirementCard.jsx";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Title } from "../../../components/ui/Title/Title.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { LockIndicator } from "../LockIndicator/LockIndicator.jsx";
import { trackProductEvent } from "../../analytics/analytics-client.js";
import { CardEditScope } from "../../../components/ui/CardEditing/CardEditing.jsx";
import { EditableLayout } from "../../../components/ui/CardEditing/EditableLayout.jsx";

const departmentCodeOrder = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

export function FloorGroup({
  floor,
  category,
  targets = [],
  floorAvailable,
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
  if (category) {
    return (
      <article className="floor-group">
        <ul className="floor-work-list">
          {works.map((department) => (
            <FloorDepartmentContent
              key={department.id}
              department={department}
              category={category}
              available={departmentAvailability?.[department.code]}
              targets={targets.filter(
                (target) => target.departmentId === department.id,
              )}
              onUpgradeSelect={onUpgradeSelect}
            />
          ))}
        </ul>
      </article>
    );
  }
  const openingConditions =
    floor.openingConditions ||
    (floor.code === "A" ? [] : works[0]?.openingConditions || []);
  const isFloorView = viewMode === "floors";
  const floorOpeningCard =
    isFloorView && openingConditions.length > 0 ? (
      <details
        key={`${floor.id}-${floorAvailable ?? "unknown"}`}
        className="floor-opening-disclosure floor-work-disclosure"
        open={floorAvailable === false}
        onToggle={(event) => {
          if (event.currentTarget.open)
            trackProductEvent("floor_requirements_open", {
              section: "floors",
              feature: "floor_requirements",
              subject: floor.code,
            });
        }}
      >
        <summary className="floor-work-summary floor-opening-summary">
          <CardTitle editKey="opening-title" className="floor-opening-heading">
            <span>Условия открытия этажа </span>
            <EditableValue editKey="code" className="floor-opening-code">
              {floor.code}
            </EditableValue>
          </CardTitle>
          <LockIndicator
            size="medium"
            locked={floorAvailable !== true}
            label={
              floorAvailable == null
                ? `Условия открытия этажа ${floor.code}`
                : `Этаж ${floor.code} ${floorAvailable ? "открыт" : "заблокирован"}`
            }
          />
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
      <BaseCard
        editKey="opening-card"
        variant="floor-data"
        className="floor-opening-card"
      >
        <Title as="h4" editKey="opening-title" className="floor-opening-title">
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
    <CardEditScope scope={`floor:${floor.id}`}>
      <EditableLayout
        as="article"
        editKey="layout"
        stack
        className="floor-group"
        key={floor.id}
      >
        {!isFloorView && (
          <Title as="h3" editKey="heading" className="floor-heading">
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
      </EditableLayout>
    </CardEditScope>
  );
}
