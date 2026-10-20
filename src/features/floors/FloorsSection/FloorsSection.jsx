import { useEffect, useRef, useState } from "react";
import { ContentSection } from "../../../components/ui/ContentSection/ContentSection.jsx";
import "./FloorsSection.css";
import { orderedFloors } from "../../../model/knowledge-base.js";
import { FloorGroup } from "../FloorGroup/FloorGroup.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { Title } from "../../../components/ui/Title/Title.jsx";
export function FloorsSection({ onCalculator, onUpgradeSelect }) {
  const [view, setView] = useState("floors");
  const [selectedFloorId, setSelectedFloorId] = useState(
    orderedFloors[0]?.id || null,
  );
  const [focusedDepartmentId, setFocusedDepartmentId] = useState(null);
  const departmentRefs = useRef({});
  const selectedFloor = orderedFloors.find(
    (floor) => floor.id === selectedFloorId,
  );

  const renderFloor = (floor) => (
    <FloorGroup
      key={floor.id}
      floor={floor}
      viewMode={view}
      onCalculator={onCalculator}
      onUpgradeSelect={onUpgradeSelect}
      focusedDepartmentId={focusedDepartmentId}
      registerDepartment={(id, node) => { departmentRefs.current[id] = node; }}
      onRequirementSelect={(department) => {
        setView("floors");
        setSelectedFloorId(department.floorId);
        setFocusedDepartmentId(department.id);
      }}
    />
  );

  useEffect(() => {
    if (!focusedDepartmentId) return;
    const node = departmentRefs.current[focusedDepartmentId];
    if (!node) return;
    node.open = true;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusedDepartmentId, selectedFloorId, view]);

  return (
    <ContentSection
      className="floors-section"
      id="floors"
      aria-labelledby="floors-title"
    >
      <Title as="h2" className="sr-only" id="floors-title">
        Этажи и работёнки
      </Title>
      <div className="floor-view-controls">
        <Title as="h2" className="floor-view-title">Этажи</Title>
        <div className="floor-view-switch" role="group" aria-label="Вид этажей">
          <Button
            variant="secondary"
            className={`floor-view-option${view === "floors" ? " is-active" : ""}`}
            aria-pressed={view === "floors"}
            onClick={() => setView("floors")}
          >
            По этажам
          </Button>
          <Button
            variant="secondary"
            className={`floor-view-option${view === "list" ? " is-active" : ""}`}
            aria-pressed={view === "list"}
            onClick={() => setView("list")}
          >
            Список
          </Button>
        </div>
      </div>

      {view === "floors" && (
        <div className="floor-selector" role="group" aria-label="Выберите этаж">
          {orderedFloors.map((floor) => (
            <Button
              key={floor.id}
              variant="secondary"
              className={`floor-selector-tile${floor.id === selectedFloorId ? " is-active" : ""}`}
              aria-label={`Этаж ${floor.code}`}
              aria-pressed={floor.id === selectedFloorId}
              onClick={() => setSelectedFloorId(floor.id)}
            >
              <span className="floor-selector-code">
                <span className="floor-selector-dash">–</span>
                <span>{floor.code}</span>
                <span className="floor-selector-dash">–</span>
              </span>
            </Button>
          ))}
        </div>
      )}

      <div className="floor-grid" aria-live="polite">
        {view === "list"
          ? orderedFloors.map(renderFloor)
          : selectedFloor
            ? renderFloor(selectedFloor)
            : null}
      </div>
    </ContentSection>
  );
}
