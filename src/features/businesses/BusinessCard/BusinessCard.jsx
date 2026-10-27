import { useBusinessState } from "../state/useBusinessState.js";
import { fmt } from "../../../lib/format.js";
import { renderDisplayFields } from "../../../components/ui/CardEditing/DisplayFields.jsx";
import { useMobileCardAction } from "../../../components/ui/BaseCard/useMobileCardAction.js";
import { EditableLayout } from "../../../components/ui/CardEditing/EditableLayout.jsx";
import { CardEditScope } from "../../../components/ui/CardEditing/CardEditing.jsx";
import "./BusinessCard.css";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { Pill } from "../../../components/ui/Pill/Pill.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";
import { trackProductEvent } from "../../analytics/analytics-client.js";
import {
  businessIncomeField,
  normalizeBusinessState,
} from "../state/business-state.js";
import { LockIndicator } from "../../floors/LockIndicator/LockIndicator.jsx";

export function BusinessCard({
  business,
  upgrade,
  onUpgradeSelect,
  children,
  targeted = false,
  goalAction,
  department,
  locked = false,
  businessState: listedState,
  businessStateProvided = false,
}) {
  const detailState = useBusinessState(
    business,
    !locked && !businessStateProvided,
  );
  const current = businessStateProvided
    ? normalizeBusinessState(listedState, business)
    : detailState;
  const incomeField = businessIncomeField(current?.income ?? []);
  const levelText =
    current?.level != null
      ? `Уровень ${fmt(current.level)}`
      : "Уровень неизвестен";
  const openLevels = () => {
    if (locked || typeof onUpgradeSelect !== "function") return;
    trackProductEvent("business_upgrades_open", {
      section: "businesses",
      feature: "business_upgrades",
      subject: business.id,
    });
    onUpgradeSelect({ business, upgrade });
  };
  const { mobile, cardProps } = useMobileCardAction({
    enabled: !locked && typeof onUpgradeSelect === "function",
    label: `Уровни бизнеса: ${business.title}`,
    onActivate: openLevels,
  });
  const fields = [
    { id: "block", label: "Отделение", value: department?.code || "" },
    { id: "name", label: "Название бизнеса", value: business.title },
    { id: "level", label: "Уровень", value: levelText },
    incomeField,
  ];
  return (
    <CardEditScope scope={`business:${business.id}`}>
      <BaseCard
        editKey="card"
        variant="floor-data"
        data-department-id={department?.id}
        state={locked ? "locked" : targeted ? "target" : undefined}
        as="li"
        className={`floor-business-card${mobile && !locked && typeof onUpgradeSelect === "function" ? " floor-business-card--mobile-action" : ""}`}
        {...cardProps}
      >
        <ImageCard
          editKey="image"
          className="floor-business-icon"
          size="var(--business-image-size)"
          imageSize="var(--business-image-content-size)"
          label={`Бизнес: ${business.title}`}
        >
          <Icon type="business" />
        </ImageCard>
        <EditableLayout editKey="copy-layout" className="floor-business-copy">
          <div className="floor-business-heading">
            <CardTitle
              composition={{
                fields,
                defaultFields: department ? ["block", "name"] : ["name"],
              }}
              editKey="title"
              className="floor-work-business-name"
            >
              {[department?.code, business.title].filter(Boolean).join(" • ")}
            </CardTitle>
            {locked ? (
              <LockIndicator variant="locked" label="Бизнес недоступен" />
            ) : (
              current?.level != null && (
                <Pill
                  variant="scheduled"
                  size="xs"
                  dot={false}
                  aria-label={levelText}
                >
                  Ур. {fmt(current.level)}
                </Pill>
              )
            )}
          </div>
          <CardDescription
            composition={{ fields, defaultFields: ["income"] }}
            editKey="income"
            as="small"
            className="floor-business-income"
          >
            {renderDisplayFields(fields, ["income"])}
          </CardDescription>
          {children}
        </EditableLayout>
        {!mobile && !locked && (
          <div className="floor-business-actions">
            <Button
              editKey="action"
              variant="card-action"
              icon="levels"
              title="Уровни бизнеса"
              className="business-upgrade-open"
              aria-label={`Требования по предметам для бизнеса «${business.title}»`}
              onClick={openLevels}
            >
              Уровни
            </Button>
            {goalAction}
          </div>
        )}
      </BaseCard>
    </CardEditScope>
  );
}
