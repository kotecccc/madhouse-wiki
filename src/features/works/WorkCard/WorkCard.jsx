import { useState, useSyncExternalStore } from "react";
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

const mobileQuery = "(max-width: 650px)";
function subscribe(onChange) {
  const query = window.matchMedia(mobileQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
const getMobile = () => window.matchMedia(mobileQuery).matches;
const getServerMobile = () => false;

export function WorkCard({ work, department, onCalculator, preset }) {
  const [open, setOpen] = useState(false);
  const mobile = useSyncExternalStore(subscribe, getMobile, getServerMobile);
  const variant = getWorkCardVariantProps(preset, mobile);
  if (!work) return null;
  const energy = department?.energyCycle?.full;
  const departmentWork = department?.work;
  const fields = [
    { id: "name", label: "Работёнка", value: work.title || "" },
    { id: "block", label: "Блок", value: department?.code || "" },
    { id: "department", label: "Отделение", value: department?.name || "" },
    { id: "stash", label: "Тайник", value: departmentWork?.stash || "" },
    {
      id: "energy",
      label: "Энергия",
      value: energy == null ? "" : `Энергия ${fmt(energy)}`,
    },
  ];
  const showCalculator = (mode) => {
    if (onCalculator) onCalculator({ work, mode });
    else setOpen(true);
  };
  return (
    <CardEditScope scope={`work:${work.id}`}>
      <BaseCard editKey="card" className="work-card" variant="floor-data">
        <div className="work-card-heading">
          <ImageCard
            editKey="image"
            className="image-card--work"
            size="var(--work-image-card-size)"
            imageSize="var(--work-image-size)"
            src={departmentWork?.image}
            label={departmentWork?.stash || "Отделение"}
            title={departmentWork?.stash || "Отделение"}
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
              {[department?.code, work.title].filter(Boolean).join(" • ")}
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
              )}
            </CardDescription>
          </div>
        </div>
        <div className="work-card-footer">
          <span className="work-card-energy">
            <EditableValue editKey="energy">
              {energy == null ? "—" : fmt(energy)}
            </EditableValue>{" "}
            <Icon type="energy" size="small" />
          </span>
          <Button
            editKey="calculator-button"
            size={variant?.buttonSize}
            variant="card-action"
            icon="calc"
            onClick={() => showCalculator("cycle")}
          >
            Калькулятор
          </Button>
        </div>
      </BaseCard>
      <WorkCalculatorDialog
        work={work}
        energy={energy}
        visible={open}
        onClose={() => setOpen(false)}
      />
    </CardEditScope>
  );
}
