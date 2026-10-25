import { useMobileCardAction } from "../../../components/ui/BaseCard/useMobileCardAction.js";
import { EditableLayout } from "../../../components/ui/CardEditing/EditableLayout.jsx";
import { CardEditScope } from "../../../components/ui/CardEditing/CardEditing.jsx";
import "./BusinessCard.css";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";
import { trackProductEvent } from "../../analytics/analytics-client.js";

export function BusinessCard({
  business,
  upgrade,
  onUpgradeSelect,
  children,
  targeted = false,
  goalAction,
  department,
  locked = false,
}) {
  const openLevels = () => {
    trackProductEvent("business_upgrades_open", {
      section: "businesses",
      feature: "business_upgrades",
      subject: business.id,
    });
    onUpgradeSelect({ business, upgrade });
  };
  const { mobile, cardProps } = useMobileCardAction({
    enabled: typeof onUpgradeSelect === "function",
    label: `Уровни бизнеса: ${business.title}`,
    onActivate: openLevels,
  });
  const fields = [
    { id: "block", label: "Отделение", value: department?.code || "" },
    { id: "name", label: "Название бизнеса", value: business.title },
    { id: "income", label: "Доход", value: "Доход не указан" },
  ];
  return (
    <CardEditScope scope={`business:${business.id}`}>
      <BaseCard
        editKey="card"
        variant="floor-data"
        state={locked ? "locked" : targeted ? "target" : undefined}
        as="li"
        className={`floor-business-card${mobile ? " floor-business-card--mobile-action" : ""}`}
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
          <CardDescription
            composition={{ fields, defaultFields: ["income"] }}
            editKey="income"
            as="small"
            className="floor-business-income"
          >
            Доход не указан
          </CardDescription>
          {children}
        </EditableLayout>
        {!mobile && (
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
