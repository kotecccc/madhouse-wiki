import { useEffect, useRef, useState } from "react";
import { ContentSection } from "../../../components/ui/ContentSection/ContentSection.jsx";
import "./FloorsSection.css";
import {
  orderedFloors,
  departmentById,
} from "../../../model/knowledge-base.js";
import { FloorGroup } from "../FloorGroup/FloorGroup.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { Title } from "../../../components/ui/Title/Title.jsx";
import { LockIndicator } from "../LockIndicator/LockIndicator.jsx";
import { useDepartmentAvailability } from "../useDepartmentAvailability.js";
import {
  readSession,
  subscribeSession,
} from "../../../../shared/auth-session.js";
import { trackProductEvent } from "../../analytics/analytics-client.js";
export function FloorsSection({
  availability,
  status,
  retry,
  onCalculator,
  onUpgradeSelect,
  onDepartmentState,
  selectedFloorCode,
}) {
  const [selectedFloorId, setSelectedFloorId] = useState(null);
  const [focusedDepartmentId, setFocusedDepartmentId] = useState(null);
  const departmentRefs = useRef({});
  const lastAvailableFloorCode = [...orderedFloors]
    .reverse()
    .find((floor) => availability[floor.code] === true)?.code;
  const defaultFloor =
    status === "ready" && readSession().status === "ready"
      ? orderedFloors.find((floor) => floor.code === lastAvailableFloorCode) ||
        orderedFloors[0]
      : orderedFloors[0];
  const selectedFloor =
    orderedFloors.find((floor) => floor.id === selectedFloorId) || defaultFloor;

  useEffect(() => {
    if (!selectedFloorCode) return;
    const floor = orderedFloors.find((item) => item.code === selectedFloorCode);
    if (floor) setSelectedFloorId(floor.id);
  }, [selectedFloorCode]);

  useEffect(() => {
    let previousStatus = readSession().status;
    return subscribeSession(() => {
      const nextStatus = readSession().status;
      if (previousStatus !== "ready" && nextStatus === "ready")
        setSelectedFloorId(null);
      previousStatus = nextStatus;
    });
  }, []);

  const departmentState = useDepartmentAvailability(
    selectedFloor?.code,
    status,
    availability[selectedFloor?.code],
    selectedFloor?.code === lastAvailableFloorCode,
  );
  useEffect(() => {
    if (
      departmentState.status === "ready" ||
      departmentState.status === "error"
    )
      onDepartmentState?.(departmentState);
  }, [departmentState, onDepartmentState]);
  const departmentAvailability =
    availability[selectedFloor?.code] === false
      ? Object.fromEntries(
          (selectedFloor?.departmentIds || []).map((id) => [
            departmentById[id]?.code,
            false,
          ]),
        )
      : selectedFloor?.code === lastAvailableFloorCode
        ? departmentState.availability
        : {};

  const renderFloor = (floor) => (
    <FloorGroup
      key={floor.id}
      floor={floor}
      floorAvailable={status === "ready" ? availability[floor.code] : undefined}
      departmentAvailability={departmentAvailability}
      viewMode="floors"
      onCalculator={onCalculator}
      onUpgradeSelect={onUpgradeSelect}
      focusedDepartmentId={focusedDepartmentId}
      registerDepartment={(id, node) => {
        departmentRefs.current[id] = node;
      }}
      onRequirementSelect={(department) => {
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
  }, [focusedDepartmentId, selectedFloorId]);

  return (
    <ContentSection
      className="floors-section"
      id="floors"
      aria-labelledby="floors-title"
    >
      <Title as="h2" className="sr-only" id="floors-title">
        Этажи и работёнки
      </Title>
      {status === "loading" ? (
        <div
          className="floor-availability-state"
          role="status"
          aria-live="polite"
        >
          <span className="floor-availability-spinner" aria-hidden="true" />
          <span>Загружаем доступность этажей…</span>
        </div>
      ) : status === "error" ? (
        <div
          className="floor-availability-state floor-availability-error"
          role="alert"
        >
          <span>Не удалось загрузить доступность этажей.</span>
          <Button variant="secondary" onClick={retry}>
            Повторить
          </Button>
        </div>
      ) : (
        <>
          <div
            className="floor-selector"
            role="group"
            aria-label="Выберите этаж"
          >
            {orderedFloors.map((floor) => (
              <Button
                key={floor.id}
                variant="secondary"
                className={`floor-selector-tile${floor.id === selectedFloor?.id ? " is-active" : ""}`}
                aria-label={`Этаж ${floor.code}${availability[floor.code] === false ? " — заблокирован в игре" : ""}`}
                aria-pressed={floor.id === selectedFloor?.id}
                onClick={() => {
                  setSelectedFloorId(floor.id);
                  trackProductEvent("floor_select", {
                    section: "floors",
                    feature: "floor_catalogue",
                    subject: floor.code,
                  });
                }}
              >
                <span className="floor-selector-code">
                  <span className="floor-selector-dash">–</span>
                  <span>{floor.code}</span>
                  {availability[floor.code] === false && (
                    <LockIndicator className="floor-selector-lock" />
                  )}
                  <span className="floor-selector-dash">–</span>
                </span>
              </Button>
            ))}
          </div>

          {departmentState.status === "loading" && (
            <p className="department-access-status sr-only" role="status">
              Загружаем доступность отделений…
            </p>
          )}
          {departmentState.status === "error" && (
            <p className="department-access-status" role="status">
              Доступность отделений не удалось проверить.
            </p>
          )}
          <div className="floor-grid" aria-live="polite">
            {selectedFloor ? renderFloor(selectedFloor) : null}
          </div>
        </>
      )}
    </ContentSection>
  );
}
