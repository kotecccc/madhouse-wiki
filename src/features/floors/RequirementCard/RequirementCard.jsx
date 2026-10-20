import "./RequirementCard.css";
import { useState } from "react";
import { BusinessRequirementDialog } from "../../businesses/BusinessRequirementDialog/BusinessRequirementDialog.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import {
  bossById,
  departmentById,
  businessById,
  getRequirementDepartment,
} from "../../../model/knowledge-base.js";
import { fmt } from "../../../lib/format.js";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
export function RequirementCard({
  requirement: r,
  work,
  onCalculator,
  embedded = false,
}) {
  const [showRequirements, setShowRequirements] = useState(false);
  const boss = r.targetBossId ? bossById[r.targetBossId] : null;
  const targetWork = r.targetDepartmentId
    ? departmentById[r.targetDepartmentId]
    : null;
  const business = r.targetBusinessId ? businessById[r.targetBusinessId] : null;
  const type = r.type;
  const targetDepartment = getRequirementDepartment(r);
  const label = r.label || "Условие не указано";
  const img =
    type === "boss_kills"
      ? boss?.image
      : type === "work_completions"
        ? targetWork?.work?.image
        : null;
  const iconType =
    {
      business_level: "business",
      department_open: "floor",
      combat_rating: "combat",
      rage_total: "fire",
      dice_level: "dice",
      stash_medallion: "stash",
    }[type] || "business";
  const iconAlt =
    type === "boss_kills"
      ? `Босс: ${boss?.name || label}`
      : type === "work_completions"
        ? `Работёнка: ${targetWork?.work?.title || label}`
        : `Бизнес: ${business?.title || label}`;
  let energy = null;
  if (type === "work_completions" && targetWork?.energyCycle?.full != null)
    energy = targetWork.energyCycle.full * r.required;
  const amount =
    type === "business_level"
      ? r.requiredLevel == null && r.required == null
        ? "Ур. не указан"
        : `${r.requiredLevel ?? r.required} ур.`
      : type === "department_open"
        ? "Открыт"
        : [
              "combat_rating",
              "rage_total",
              "dice_level",
              "stash_medallion",
            ].includes(type)
          ? type === "dice_level"
            ? `${fmt(Number(r.required) || 0)} ур.`
            : type === "stash_medallion"
              ? "Коллекция"
              : fmt(Number(r.required) || 0)
          : `×${fmt(Number(r.required) || 0)}`;
  const content = (
    <>
      <ImageCard
        src={img}
        alt={img ? iconAlt : ""}
        size="var(--requirement-image-size)"
        imageSize="var(--requirement-image-content-size)"
      >
        {!img && <Icon type={iconType} />}
      </ImageCard>
      <div className="requirement-card-copy">
        <CardTitle>{label}</CardTitle>
        <CardDescription as="small">
          {type === "boss_kills"
            ? departmentById[boss?.departmentId]?.code || ""
            : type === "work_completions"
              ? targetWork?.code || ""
              : type === "business_level"
                ? work?.code || targetDepartment?.code || ""
                : label}
        </CardDescription>
      </div>
      {type !== "department_open" && (
        <div className="requirement-card-visual">
          {energy != null ? (
            <>
              <span className="requirement-work-total">{fmt(energy)} ⚡</span>
              <Button
                variant="card-action"
                icon="calc"
                type="button"
                aria-label={`Рассчитать энергию для условия «${label}»`}
                title="Рассчитать энергию"
                onClick={() => onCalculator({ requirement: r, energy })}
              >
                Калькулятор
              </Button>
            </>
          ) : type === "business_level" ? (
            <Button
              variant="card-action"
              icon="levels"
              title="Что собирать?"
              onClick={() => setShowRequirements(true)}
            >
              Что собирать?
            </Button>
          ) : (
            <span
              className={`requirement-amount${type === "business_level" ? " requirement-amount--level" : ""}`}
              aria-label={
                type === "business_level"
                  ? `Требуемый уровень: ${amount}`
                  : `Требуемое количество: ${amount}`
              }
            >
              {amount}
            </span>
          )}
        </div>
      )}
      {showRequirements && (
        <BusinessRequirementDialog
          business={business}
          requirement={r}
          onClose={() => setShowRequirements(false)}
        />
      )}
    </>
  );

  return embedded ? (
    <div
      className={`requirement-card requirement-card--embedded requirement-card-${type || "unknown"}`}
    >
      {content}
    </div>
  ) : (
    <BaseCard
      variant="floor-data"
      as="li"
      className={`requirement-card requirement-card-${type || "unknown"}`}
    >
      {content}
    </BaseCard>
  );
}
