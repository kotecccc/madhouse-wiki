import { knowledgeBase } from "virtual:madhouse-catalogue";
import { progressionTargets } from "../progression-targets.js";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
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
import { Divider } from "../../../components/ui/Divider/Divider.jsx";
import { LockIndicator } from "../LockIndicator/LockIndicator.jsx";
import { useDepartmentAvailability } from "../useDepartmentAvailability.js";
import {
  readSession,
  subscribeSession,
} from "../../../../shared/auth-session.js";
import { trackProductEvent } from "../../analytics/analytics-client.js";
export function FloorsSection({
  availability,
  floorDetails,
  status,
  onCalculator,
  onUpgradeSelect,
  onDepartmentState,
  selectedFloorCode,
  isAuthenticated = false,
}) {
  const [categorySelection, setCategorySelection] = useState(null);
  const [confirmedDepartmentState, setConfirmedDepartmentState] =
    useState(null);
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
    if (floor) {
      setSelectedFloorId(floor.id);
      setCategorySelection(null);
    }
  }, [selectedFloorCode]);

  useEffect(() => {
    let previousStatus = readSession().status;
    return subscribeSession(() => {
      const nextStatus = readSession().status;
      if (previousStatus !== "ready" && nextStatus === "ready") {
        setSelectedFloorId(null);
        setCategorySelection(null);
      }
      setConfirmedDepartmentState(null);
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
    if (departmentState.status === "ready")
      setConfirmedDepartmentState(departmentState);
  }, [departmentState]);
  const category =
    categorySelection?.floorId === selectedFloor?.id
      ? categorySelection.category
      : "work";
  const targets = progressionTargets({
    floors: orderedFloors,
    departments: knowledgeBase.departments,
    bosses: knowledgeBase.bosses,
    businesses: knowledgeBase.businesses,
    availability,
    floorDetails,
    departmentState:
      departmentState.status === "ready"
        ? departmentState
        : confirmedDepartmentState || {},
  }).filter((target) =>
    (selectedFloor?.departmentIds || []).includes(target.departmentId),
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
        : availability[selectedFloor?.code] === true
          ? Object.fromEntries(
              (selectedFloor?.departmentIds || []).map((id) => [
                departmentById[id]?.code,
                true,
              ]),
            )
          : {};

  const renderFloor = (floor) => (
    <FloorGroup
      key={floor.id}
      floor={floor}
      category={category}
      targets={targets}
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
      {isAuthenticated && (
        <div className="floors-section-heading" aria-hidden="true">
          <Divider />
          <Title as="h2">Этажи и работёнки</Title>
        </div>
      )}
      <Title as="h2" className="sr-only" id="floors-title">
        Этажи и работёнки
      </Title>
      <div className="floor-selector" role="group" aria-label="Выберите этаж">
        {orderedFloors.map((floor) => (
          <Button
            key={floor.id}
            variant={
              availability[floor.code] === false ? "locked" : "secondary"
            }
            className="floor-selector-tile"
            aria-label={[
              `Этаж ${floor.code}`,
              floor.id === selectedFloor?.id ? "выбран" : null,
              availability[floor.code] === false ? "заблокирован в игре" : null,
            ]
              .filter(Boolean)
              .join(" — ")}
            aria-pressed={floor.id === selectedFloor?.id}
            onClick={() => {
              if (floor.id !== selectedFloor?.id) setCategorySelection(null);
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
                <LockIndicator
                  variant="locked"
                  size="medium"
                  className="floor-selector-lock"
                />
              )}
              <span className="floor-selector-dash">–</span>
            </span>
          </Button>
        ))}
      </div>

      <div
        className="floor-category-selector"
        role="group"
        aria-label="Категория этажа"
      >
        {[
          ["work", "Работа"],
          ["bosses", "Боссы"],
          ["businesses", "Бизнесы"],
        ].map(([value, label]) => {
          const isTarget = targets.some((target) => target.category === value);
          return (
            <Button
              key={value}
              variant="secondary"
              size="lg"
              className="floor-category-button"
              aria-pressed={category === value}
              aria-label={`${label}${isTarget ? " — есть задача для открытия" : ""}`}
              onClick={() =>
                setCategorySelection({
                  floorId: selectedFloor.id,
                  category: value,
                })
              }
            >
              <span>{label}</span>
              {isTarget && (
                <span
                  className="floor-category-target"
                  role="img"
                  aria-label="Задача для открытия"
                >
                  <Icon type="star" size="medium" />
                </span>
              )}
            </Button>
          );
        })}
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
    </ContentSection>
  );
}
