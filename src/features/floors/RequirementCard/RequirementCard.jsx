import "./RequirementCard.css";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import {
  bossById,
  departmentById,
  businessById,
} from "../../../model/knowledge-base.js";
import { fmt } from "../../../lib/format.js";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
export function RequirementCard({ requirement: r, work, onCalculator }) {
  const boss = r.targetBossId ? bossById[r.targetBossId] : null;
  const targetWork = r.targetDepartmentId
    ? departmentById[r.targetDepartmentId]
    : null;
  const business = r.targetBusinessId ? businessById[r.targetBusinessId] : null;
  const type = r.type;
  const label = r.label || "Условие не указано";
  const img =
    type === "boss_kills"
      ? boss?.image
      : type === "work_completions"
        ? targetWork?.work?.image
        : null;
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
      ? `${r.requiredLevel ?? r.required} ур.`
      : `×${fmt(Number(r.required) || 0)}`;
  return (
    <BaseCard
      variant="floor-data"
      as="li"
      className={`requirement-card requirement-card-${type || "unknown"}`}
    >
      <ImageCard src={img} alt={img ? iconAlt : ""}>
        {!img && <Icon type="business" />}
      </ImageCard>
      <div className="requirement-card-copy">
        <CardTitle>{label}</CardTitle>
        <CardDescription as="small">
          {type === "boss_kills"
            ? departmentById[boss?.departmentId]?.code || ""
            : type === "work_completions"
              ? targetWork?.code || ""
              : type === "business_level"
                ? work.code
                : label}
        </CardDescription>
      </div>
      <div className="requirement-card-visual">
        {energy != null ? (
          <>
            <span className="requirement-work-total">{fmt(energy)} ⚡</span>
            <Button
              variant="secondary"
              className="requirement-calculator-icon"
              type="button"
              aria-label={`Рассчитать энергию для условия «${label}»`}
              title="Рассчитать энергию"
              onClick={() => onCalculator({ requirement: r, energy })}
            >
              <Icon type="calc" />
            </Button>
          </>
        ) : (
          <BaseCard
            as="span"
            className="media-tile-value"
            aria-label={
              type === "business_level"
                ? `Требуемый уровень: ${amount}`
                : `Требуемое количество: ${amount}`
            }
          >
            {amount}
          </BaseCard>
        )}
      </div>
    </BaseCard>
  );
}
