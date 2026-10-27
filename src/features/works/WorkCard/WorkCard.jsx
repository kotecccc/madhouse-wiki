import { useMobileCardAction } from "../../../components/ui/BaseCard/useMobileCardAction.js";
import { LockIndicator } from "../../floors/LockIndicator/LockIndicator.jsx";
import { useState } from "react";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardEditScope } from "../../../components/ui/CardEditing/CardEditing.jsx";
import { EditableValue } from "../../../components/ui/CardEditing/EditableValue.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";
import { fmt } from "../../../lib/format.js";
import { composeDisplayFields } from "../../../lib/card-display-fields.js";
import { getWorkCardVariantProps } from "./work-card-variants.js";
import { WorkCalculatorDialog } from "./WorkCalculatorDialog.jsx";
import "./WorkCard.css";

export function WorkCard({
  work,
  department,
  preset,
  children,
  targeted = false,
  goalTargets = [],
  as = "div",
  locked = false,
  placeholder = false,
}) {
  const [open, setOpen] = useState(false);
  const { mobile, cardProps } = useMobileCardAction({
    enabled: !!work && !placeholder,
    label: `Настроить фарм: ${work?.title || "Работёнка"}`,
    onActivate: () => setOpen(true),
  });
  const variant = getWorkCardVariantProps(preset, mobile);
  if (!work && !placeholder) return null;
  const energy = placeholder ? null : department?.energyCycle?.full;
  const departmentWork = department?.work;
  const stash = departmentWork?.stash || department?.stashPreview?.title || "";
  const image = departmentWork?.image || department?.stashPreview?.image;
  const fields = [
    {
      id: "name",
      label: "Работёнка",
      value: work?.title || (placeholder ? "Работёнка" : ""),
    },
    { id: "block", label: "Блок", value: department?.code || "" },
    { id: "department", label: "Отделение", value: department?.name || "" },
    { id: "stash", label: "Тайник", value: stash },
    {
      id: "energy",
      label: "Энергия",
      value: energy == null ? "" : `Энергия ${fmt(energy)}`,
    },
  ];
  const showFarm = () => {
    if (!work) return;
    setOpen(true);
  };
  return (
    <CardEditScope
      scope={
        work
          ? `work:${work.id}`
          : `department:${department?.id}:work-placeholder`
      }
    >
      <BaseCard
        as={as}
        data-department-id={department?.id}
        state={locked ? "locked" : targeted ? "target" : undefined}
        editKey="card"
        className="work-card"
        variant="floor-data"
        {...cardProps}
      >
        <div className="work-card-heading">
          <ImageCard
            editKey="image"
            className="image-card--work"
            size="var(--work-image-card-size)"
            imageSize="var(--work-image-size)"
            src={image}
            label={stash || "Отделение"}
            title={stash || "Отделение"}
          >
            <Icon type="department" />
          </ImageCard>
          <div className="work-card-copy">
            <CardTitle
              as="h3"
              editKey="title"
              size={variant?.titleSize}
              composition={{ fields, defaultFields: ["block", "name"] }}
            >
              {[
                department?.code,
                work?.title || (placeholder ? "Работёнка" : ""),
              ]
                .filter(Boolean)
                .join(" • ")}
            </CardTitle>
            <CardDescription
              editKey="description"
              size={variant?.descriptionSize}
              composition={{
                fields,
                defaultFields: variant?.descriptionFields || [
                  "department",
                  "stash",
                ],
              }}
            >
              {composeDisplayFields(
                fields,
                variant?.descriptionFields || ["department", "stash"],
              ) || (placeholder ? "Данные работёнки пока недоступны" : "")}
            </CardDescription>
            {children}
          </div>
        </div>
        <div className="work-card-footer">
          <span className="work-card-energy">
            {locked ? (
              <LockIndicator variant="locked" size="small" />
            ) : (
              <>
                <EditableValue editKey="energy">
                  {energy == null ? "—" : fmt(energy)}
                </EditableValue>{" "}
                <Icon type="energy" size="small" />
              </>
            )}
          </span>
          {!mobile && (
            <Button
              editKey="calculator-button"
              size={variant?.buttonSize}
              variant="card-action"
              accent={targeted ? "gold" : undefined}
              icon="brain"
              disabled={placeholder}
              aria-haspopup="dialog"
              aria-label={`Настроить фарм: ${work?.title || "Работёнка"}`}
              title="Настроить количество выполнений и рассчитать энергию"
              onClick={showFarm}
            >
              Фарм
            </Button>
          )}
        </div>
      </BaseCard>
      <WorkCalculatorDialog
        work={work}
        energy={energy}
        goalTargets={goalTargets}
        visible={open}
        onClose={() => setOpen(false)}
      />
    </CardEditScope>
  );
}
