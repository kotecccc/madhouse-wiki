import { ErrorToast } from "../../../components/ui/ErrorToast/ErrorToast.jsx";
import { useBossCollection } from "../../bosses/collection/useBossCollection.js";
import { Skeleton } from "../../../components/ui/Skeleton/Skeleton.jsx";
import { knowledgeBase } from "virtual:madhouse-catalogue";
import { progressionTargets } from "../progression-targets.js";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { SegmentedControl } from "../../../components/ui/SegmentedControl/SegmentedControl.jsx";
import { LockIndicator } from "../LockIndicator/LockIndicator.jsx";
import { useDepartmentAvailability } from "../useDepartmentAvailability.js";
import { useFloorBusinessStates } from "../../businesses/state/useFloorBusinessStates.js";
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
  onLoadingChange,
  selectedFloorCode,
  queueFocus,
  onQueueFocusHandled,
  onVisibleFloorChange,
  isAuthenticated = false,
  playerLevel,
}) {
  const [category, setCategory] = useState("work");
  const [confirmedDepartmentState, setConfirmedDepartmentState] =
    useState(null);
  const [selectedFloorId, setSelectedFloorId] = useState(null);
  const [focusedDepartmentId, setFocusedDepartmentId] = useState(null);
  const [focusedEntityId, setFocusedEntityId] = useState(null);
  const [departmentFocusSequence, setDepartmentFocusSequence] = useState(0);
  const departmentRefs = useRef({});
  const floorGridRef = useRef(null);
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
    onVisibleFloorChange?.(selectedFloor?.code ?? null);
  }, [onVisibleFloorChange, selectedFloor?.code]);

  useEffect(() => {
    if (!selectedFloorCode) return;
    const floor = orderedFloors.find((item) => item.code === selectedFloorCode);
    if (floor) {
      setSelectedFloorId(floor.id);
    }
  }, [selectedFloorCode]);

  useEffect(() => {
    if (!queueFocus) return;
    const department = departmentById[queueFocus.departmentId];
    const floor = orderedFloors.find((item) => item.id === department?.floorId);
    if (floor) setSelectedFloorId(floor.id);
    if (["work", "bosses", "businesses"].includes(queueFocus.category))
      setCategory(queueFocus.category);
    setFocusedDepartmentId(department?.id ?? null);
    setFocusedEntityId(queueFocus.entityId ?? null);
    if (department) setDepartmentFocusSequence((sequence) => sequence + 1);
    onQueueFocusHandled?.("floor");
  }, [queueFocus, onQueueFocusHandled]);

  useEffect(() => {
    let previousStatus = readSession().status;
    return subscribeSession(() => {
      const nextStatus = readSession().status;
      if (previousStatus !== "ready" && nextStatus === "ready") {
        setSelectedFloorId(null);
      }
      setConfirmedDepartmentState(null);
      previousStatus = nextStatus;
    });
  }, []);

  const departmentState = useDepartmentAvailability(
    lastAvailableFloorCode,
    status,
    availability[lastAvailableFloorCode],
    true,
  );
  const businessStates = useFloorBusinessStates(
    selectedFloor?.code,
    isAuthenticated &&
      category === "businesses" &&
      status === "ready" &&
      availability[selectedFloor?.code] === true,
  );
  useEffect(() => {
    if (departmentState.status === "ready")
      setConfirmedDepartmentState(departmentState);
  }, [departmentState]);
  const collectionState = useBossCollection(
    knowledgeBase.bosses,
    isAuthenticated && category === "bosses",
  );
  const floorsLoading =
    status === "loading" || (isAuthenticated && status === "idle");
  const goalLoading =
    isAuthenticated &&
    status === "ready" &&
    Boolean(lastAvailableFloorCode) &&
    !["ready", "error"].includes(departmentState.status);
  const departmentsLoading =
    floorsLoading ||
    (selectedFloor?.code === lastAvailableFloorCode && goalLoading);
  useLayoutEffect(() => {
    onLoadingChange?.(
      floorsLoading || goalLoading || collectionState.status === "loading",
    );
  }, [floorsLoading, goalLoading, collectionState.status, onLoadingChange]);
  const allTargets = floorsLoading
    ? []
    : progressionTargets({
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
      });
  const targetFloorIds = new Set(
    allTargets.map((target) => departmentById[target.departmentId]?.floorId),
  );
  const targets = departmentsLoading
    ? []
    : allTargets.filter((target) =>
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

  const skeletonItems = (selectedFloor?.departmentIds || []).flatMap((id) => {
    const entities =
      category === "bosses"
        ? knowledgeBase.bosses.filter((boss) => boss.departmentId === id)
        : category === "businesses"
          ? knowledgeBase.businesses.filter(
              (business) => business.departmentId === id,
            )
          : [];
    return entities.length ? entities.map((entity) => entity.id) : [id];
  });

  const renderFloor = (floor) => (
    <FloorGroup
      key={floor.id}
      floor={floor}
      category={category}
      playerLevel={playerLevel}
      collectionState={collectionState}
      targets={targets}
      floorAvailable={status === "ready" ? availability[floor.code] : undefined}
      departmentAvailability={departmentAvailability}
      businessStates={businessStates ?? {}}
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
    const entityNode = focusedEntityId
      ? [
          ...(floorGridRef.current?.querySelectorAll("[data-entity-id]") || []),
        ].find((item) => item.dataset.entityId === String(focusedEntityId))
      : null;
    const node =
      entityNode ||
      departmentRefs.current[focusedDepartmentId] ||
      [
        ...(floorGridRef.current?.querySelectorAll("[data-department-id]") ||
          []),
      ].find((item) => item.dataset.departmentId === focusedDepartmentId);
    if (!node) return;
    if (node.tagName === "DETAILS") node.open = true;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    setFocusedDepartmentId(null);
    setFocusedEntityId(null);
  }, [
    focusedDepartmentId,
    focusedEntityId,
    departmentFocusSequence,
    selectedFloorId,
    category,
    departmentsLoading,
    collectionState.status,
  ]);

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
      <div
        className="floor-selector"
        role="group"
        aria-label="Выберите этаж"
        aria-busy={floorsLoading}
      >
        {orderedFloors.map((floor) =>
          floorsLoading ? (
            <Skeleton
              key={floor.id}
              variant="tile"
              className="floor-selector-tile"
            />
          ) : (
            <Button
              key={floor.id}
              variant={
                availability[floor.code] === false ? "locked" : "secondary"
              }
              className="floor-selector-tile"
              aria-label={[
                `Этаж ${floor.code}`,
                floor.id === selectedFloor?.id ? "выбран" : null,
                targetFloorIds.has(floor.id)
                  ? "есть задача для открытия"
                  : null,
                availability[floor.code] === false
                  ? "заблокирован в игре"
                  : null,
              ]
                .filter(Boolean)
                .join(" — ")}
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
                {(availability[floor.code] === false ||
                  targetFloorIds.has(floor.id)) && (
                  <span className="floor-selector-indicators">
                    {targetFloorIds.has(floor.id) && (
                      <span role="img" aria-label="Задача для открытия">
                        <Icon type="star" size="medium" />
                      </span>
                    )}
                    {availability[floor.code] === false && (
                      <LockIndicator variant="locked" size="medium" />
                    )}
                  </span>
                )}
                <span className="floor-selector-dash">–</span>
              </span>
            </Button>
          ),
        )}
      </div>

      <SegmentedControl
        label="Категория этажа"
        size="lg"
        value={category}
        onChange={setCategory}
        options={[
          ["work", "Работа"],
          ["bosses", "Боссы"],
          ["businesses", "Бизнесы"],
        ].map(([value, label]) => {
          const isTarget = targets.some((target) => target.category === value);
          if (departmentsLoading)
            return {
              value,
              ariaLabel: label,
              label: null,
              loading: true,
              disabled: true,
            };
          return {
            value,
            ariaLabel: `${label}${isTarget ? " — есть задача для открытия" : ""}`,
            label: (
              <span className="floor-category-label">
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
              </span>
            ),
          };
        })}
      />
      {departmentState.status === "loading" && (
        <p className="department-access-status sr-only" role="status">
          Загружаем доступность отделений…
        </p>
      )}
      {departmentState.status === "error" && (
        <ErrorToast message="Доступность отделений не удалось проверить." />
      )}
      <div
        ref={floorGridRef}
        className="floor-grid"
        aria-live="polite"
        aria-busy={departmentsLoading || collectionState.status === "loading"}
      >
        {departmentsLoading ||
        (category === "bosses" &&
          collectionState.status === "loading" &&
          !collectionState.bosses) ? (
          <>
            <span className="sr-only" role="status">
              Загружаем этажи, отделения и цели…
            </span>
            <article className="floor-group">
              <ul className="floor-work-list">
                {skeletonItems.map((id) => (
                  <Skeleton key={id} as="li" />
                ))}
              </ul>
            </article>
          </>
        ) : selectedFloor ? (
          renderFloor(selectedFloor)
        ) : null}
      </div>
    </ContentSection>
  );
}
