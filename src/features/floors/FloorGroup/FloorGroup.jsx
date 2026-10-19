import "./FloorGroup.css";
import { departmentById } from "../../../model/knowledge-base.js";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { FloorWorkItem } from "../FloorWorkItem/FloorWorkItem.jsx";
export function FloorGroup({ floor, onCalculator, onUpgradeSelect }) {
  const openingCondition =
    floor.openingConditionText ||
    floor.unlock ||
    "Условия открытия уточняются.";
  const works = floor.departmentIds
    .map((id) => departmentById[id])
    .filter(Boolean);
  return (
    <article className="floor-group" key={floor.id}>
      <h3 className="floor-heading">
        <span className="floor-heading-label">Этаж {floor.code}</span>
        {floor.code !== "A" && (
          <span
            className="floor-lock"
            role="img"
            aria-label={`Условия открытия: ${openingCondition}`}
            data-tooltip={openingCondition}
            tabIndex="0"
            title={openingCondition}
          >
            <Icon type="lock" />
          </span>
        )}
      </h3>
      <ul className="floor-work-list">
        {works.map((work) => (
          <FloorWorkItem
            key={work.id}
            work={work}
            onCalculator={onCalculator}
            onUpgradeSelect={onUpgradeSelect}
          />
        ))}
      </ul>
    </article>
  );
}
