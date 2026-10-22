import { useState } from "react";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardEditScope } from "../../../components/ui/CardEditing/CardEditing.jsx";
import { EditableValue } from "../../../components/ui/CardEditing/EditableValue.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";
import { BusinessRequirementDialog } from "../../businesses/BusinessRequirementDialog/BusinessRequirementDialog.jsx";
import { RequirementCalculatorDialog } from "../../calculator/RequirementCalculatorDialog/RequirementCalculatorDialog.jsx";
import {
  bossById,
  businessById,
  departmentById,
  getRequirementDepartment,
  stashSetById,
} from "../../../model/knowledge-base.js";
import { fmt } from "../../../lib/format.js";
import {
  formatRequirementAmount,
  readOpeningConditionProgress,
} from "./opening-condition-data.js";
import "./OpeningConditionCard.css";

const iconsByType = {
  business_level: "business",
  department_open: "floor",
  combat_rating: "combat",
  rage_total: "fire",
  dice_level: "dice",
  stash_medallion: "stash",
  boss_kills: "boss",
  work_completions: "department",
  player_level: "character",
};
const numericRequirementTypes = new Set([
  "business_level",
  "boss_kills",
  "work_completions",
  "player_level",
  "combat_rating",
  "rage_total",
  "dice_level",
]);

function numericValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function targetDetails(requirement) {
  const boss = requirement.targetBossId
    ? bossById[requirement.targetBossId]
    : null;
  const business = requirement.targetBusinessId
    ? businessById[requirement.targetBusinessId]
    : null;
  const targetDepartment = getRequirementDepartment(requirement);
  const stashSet = requirement.targetStashSetId
    ? stashSetById[requirement.targetStashSetId]
    : null;
  const workDepartment = requirement.targetDepartmentId
    ? departmentById[requirement.targetDepartmentId]
    : null;
  const image =
    requirement.type === "boss_kills"
      ? boss?.image
      : requirement.type === "work_completions"
        ? workDepartment?.work?.image
        : requirement.type === "business_level"
          ? business?.image || business?.logo
          : requirement.type === "stash_medallion"
            ? stashSet?.medallionReward?.imageUrl || stashSet?.previewImageUrl
            : null;
  const label =
    requirement.type === "boss_kills"
      ? boss?.name
      : requirement.type === "work_completions"
        ? workDepartment?.work?.title
        : requirement.type === "business_level"
          ? business?.title
          : requirement.type === "department_open"
            ? workDepartment?.code
              ? `Отделение ${workDepartment.code}`
              : null
            : requirement.type === "stash_medallion"
              ? stashSet?.medallionReward?.name || stashSet?.name
              : null;
  return { image, label, targetDepartment };
}

export function OpeningConditionCard({
  requirement,
  department,
  mode = "detailed",
  progress,
  onCalculator,
  onTargetSelect,
}) {
  const [businessDialog, setBusinessDialog] = useState(false);
  const [calculatorDialog, setCalculatorDialog] = useState(null);
  if (!requirement || typeof requirement !== "object") return null;

  const safeMode = ["compact", "detailed", "progress"].includes(mode)
    ? mode
    : "detailed";
  const {
    image,
    label: targetLabel,
    targetDepartment,
  } = targetDetails(requirement);
  const title =
    typeof requirement.label === "string" && requirement.label.length
      ? requirement.label
      : "Условие не указано";
  const note = [requirement.note, requirement.verification]
    .filter((value) => typeof value === "string" && value.trim())
    .join(" • ");
  const amount = formatRequirementAmount(requirement);
  const target = targetLabel || department?.code;
  const energyCycle =
    requirement.type === "work_completions"
      ? departmentById[requirement.targetDepartmentId]?.energyCycle
      : null;
  const count = numericValue(requirement.required);
  const energy =
    numericValue(energyCycle?.full) != null &&
    count != null &&
    energyCycle.full >= 0 &&
    count >= 0
      ? energyCycle.full * count
      : null;
  const displayedProgress = readOpeningConditionProgress(progress);
  const scope = `opening-condition:${requirement.id || `${requirement.type || "unknown"}:${title}`}`;

  const fields = [
    { id: "label", label: "Условие", value: title },
    { id: "target", label: "Цель", value: target || "" },
    { id: "amount", label: "Требуемое значение", value: amount || "" },
    {
      id: "block",
      label: "Блок",
      value: targetDepartment?.code || department?.code || "",
    },
    {
      id: "energy",
      label: "Энергия",
      value: energy == null ? "" : `Энергия ${fmt(energy)}`,
    },
    { id: "note", label: "Примечание", value: note },
  ];
  function openCalculator() {
    const dialog = { requirement, energy };
    if (onCalculator) onCalculator(dialog);
    else setCalculatorDialog(dialog);
  }

  return (
    <CardEditScope scope={scope}>
      <BaseCard
        as="article"
        editKey="card"
        variant="floor-data"
        className={`opening-condition-card opening-condition-card--${safeMode}`}
      >
        <ImageCard
          editKey="image"
          src={image}
          alt={image ? targetLabel || title : ""}
          size={
            safeMode === "compact"
              ? "var(--space-32)"
              : "var(--content-image-size)"
          }
          imageSize={
            safeMode === "compact"
              ? "var(--space-24)"
              : "var(--content-image-content-size)"
          }
        >
          <Icon type={iconsByType[requirement.type] || "message"} />
        </ImageCard>
        <div className="opening-condition-card-copy">
          <CardTitle
            editKey="title"
            title={title}
            size={safeMode === "compact" ? "sm" : undefined}
            composition={{ fields, defaultFields: ["label"] }}
          >
            {title}
          </CardTitle>
          {target && (
            <CardDescription
              editKey="description"
              size={safeMode === "compact" ? "xs" : undefined}
              composition={{ fields, defaultFields: ["target"] }}
            >
              {target}
            </CardDescription>
          )}
          {note && (
            <CardDescription editKey="source-note">{note}</CardDescription>
          )}
          {!iconsByType[requirement.type] && (
            <CardDescription>
              Тип условия: {requirement.type || "не указан"}
            </CardDescription>
          )}
        </div>
        <div className="opening-condition-card-values">
          {amount != null ? (
            <CardDescription aria-label={`Требуемое значение: ${amount}`}>
              <EditableValue editKey="amount">{amount}</EditableValue>
            </CardDescription>
          ) : numericRequirementTypes.has(requirement.type) ? (
            <CardDescription>
              {requirement.type === "business_level"
                ? "Уровень не указан"
                : "Значение не указано"}
            </CardDescription>
          ) : null}
          {safeMode === "progress" && (
            <CardDescription role="status">
              {displayedProgress
                ? `Прогресс: ${fmt(displayedProgress.current)} / ${fmt(displayedProgress.total)}`
                : "Прогресс не предоставлен"}
            </CardDescription>
          )}
        </div>
        <div className="opening-condition-card-actions">
          {requirement.type === "business_level" &&
            requirement.targetBusinessId &&
            businessById[requirement.targetBusinessId] && (
              <Button
                editKey="business-action"
                variant="card-action"
                icon="levels"
                type="button"
                onClick={() => setBusinessDialog(true)}
              >
                Что собирать?
              </Button>
            )}
          {requirement.type === "work_completions" && (
            <Button
              editKey="calculator-action"
              disabled={energy == null}
              variant="card-action"
              icon="calc"
              type="button"
              onClick={openCalculator}
            >
              Калькулятор
            </Button>
          )}
          {typeof onTargetSelect === "function" && targetDepartment && (
            <Button
              editKey="target-action"
              variant="secondary"
              type="button"
              onClick={() => onTargetSelect(targetDepartment)}
            >
              Перейти к отделению
            </Button>
          )}
        </div>
        {businessDialog && (
          <BusinessRequirementDialog
            business={businessById[requirement.targetBusinessId]}
            requirement={requirement}
            onClose={() => setBusinessDialog(false)}
          />
        )}
        {calculatorDialog && (
          <RequirementCalculatorDialog
            conditionDialog={calculatorDialog}
            onClose={() => setCalculatorDialog(null)}
          />
        )}
      </BaseCard>
    </CardEditScope>
  );
}
