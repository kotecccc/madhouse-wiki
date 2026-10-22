import { useState } from "react";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardEditScope } from "../../../components/ui/CardEditing/CardEditing.jsx";
import { EditableLayout } from "../../../components/ui/CardEditing/EditableLayout.jsx";
import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { NumberStepper } from "../../../components/ui/NumberStepper/NumberStepper.jsx";
import { departmentById, floorById } from "../../../model/knowledge-base.js";
import { getBusinessUpgradeTotals } from "../../../lib/business-upgrades.js";
import { fmt } from "../../../lib/format.js";
import { BusinessItemTile } from "../BusinessItemTile/BusinessItemTile.jsx";
import { UpgradeDialog } from "../UpgradeDialog/UpgradeDialog.jsx";
import { BusinessRequirementDialog } from "../BusinessRequirementDialog/BusinessRequirementDialog.jsx";
import "./BusinessEntityCard.css";

/** A shared business card for catalogue overview and level-specific requirements. */
export function BusinessEntityCard({
  business,
  upgrade,
  mode = "overview",
  as = "article",
  targetLevel: requestedLevel,
  onTargetLevelChange,
}) {
  const [dialog, setDialog] = useState(null);
  const levelCount = Math.max(
    0,
    ...(upgrade?.items ?? []).map((item) => item.levels?.length ?? 0),
  );
  const [targetLevel, setTargetLevel] = useState(Math.max(1, levelCount));
  const resolvedLevel = Math.min(
    Math.max(requestedLevel ?? targetLevel, 1),
    Math.max(levelCount, 1),
  );
  if (!business) return null;

  const isUpgrade = mode === "upgrade";
  const department = departmentById[business.departmentId];
  const floor = floorById[department?.floorId];
  const maxLevel = levelCount || null;
  const itemTotals =
    isUpgrade && levelCount
      ? getBusinessUpgradeTotals(upgrade, resolvedLevel)
      : [];
  const description = isUpgrade
    ? levelCount
      ? `Предметы для улучшения с 1 до ${resolvedLevel} уровня`
      : "Данные об уровнях отсутствуют"
    : (typeof business.description === "string" &&
        business.description.trim()) ||
      "Описание не указано";
  const fields = [
    {
      id: "name",
      label: "Название бизнеса",
      value: business.title ?? "Бизнес не указан",
    },
    {
      id: "description",
      label: isUpgrade ? "Целевой уровень" : "Описание",
      value: description,
    },
    {
      id: "block",
      label: "Блок",
      value: department?.code ? `Блок ${department.code}` : "Блок не указан",
    },
    {
      id: "floor",
      label: "Этаж",
      value: floor?.code ? `Этаж ${floor.code}` : "Этаж не указан",
    },
    {
      id: "department",
      label: "Отделение",
      value: department?.code
        ? `Отделение ${department.code}`
        : "Отделение не указано",
    },
    {
      id: "max-level",
      label: "Максимальный уровень по данным",
      value:
        maxLevel == null ? "Уровни не указаны" : `До ${fmt(maxLevel)} уровня`,
    },
    { id: "income", label: "Доход", value: "Доход не указан" },
    {
      id: "upgrade-count",
      label: "Требования к предметам",
      value: upgrade?.items?.length
        ? `Указано предметов: ${fmt(upgrade.items.length)}`
        : "Предметы для улучшения не указаны",
    },
  ];

  return (
    <CardEditScope scope={`business:${business.id}`}>
      <BaseCard
        as={as}
        editKey="card"
        variant="floor-data"
        className={`business-entity-card${isUpgrade ? " business-entity-card--upgrade" : ""}`}
      >
        <ImageCard
          editKey="image"
          className="business-entity-card__image"
          size="var(--content-image-size)"
          imageSize="var(--content-image-content-size)"
          src={business.image}
          alt={business.image ? (business.title ?? "") : ""}
          label={`Бизнес: ${business.title ?? "Бизнес"}`}
        >
          <Icon type="business" />
        </ImageCard>
        <EditableLayout
          editKey="copy-layout"
          className="business-entity-card__copy"
        >
          <CardTitle
            editKey="title"
            className="business-entity-card__title"
            composition={{ fields, defaultFields: ["name"] }}
          >
            {business.title ?? "Бизнес не указан"}
          </CardTitle>
          <CardDescription
            editKey="description"
            className="business-entity-card__description"
            composition={{
              fields,
              defaultFields: isUpgrade
                ? ["description", "max-level", "upgrade-count"]
                : [
                    "description",
                    "block",
                    "floor",
                    "department",
                    "max-level",
                    "income",
                    "upgrade-count",
                  ],
              breakBefore: isUpgrade ? [] : ["block", "max-level"],
            }}
          >
            {description}
          </CardDescription>
          {isUpgrade && levelCount > 0 && (
            <NumberStepper
              id={`business-target-level-${business.id}`}
              label="Целевой уровень"
              min={1}
              max={levelCount}
              value={resolvedLevel}
              onChange={(value) => {
                setTargetLevel(value);
                onTargetLevelChange?.(value);
              }}
            />
          )}
          {isUpgrade && levelCount > 0 && (
            <ul
              className="business-entity-card__requirements"
              aria-label={`Предметы для улучшения до уровня ${resolvedLevel}`}
            >
              {itemTotals.map((item, index) => (
                <li
                  className="business-entity-card__requirement"
                  key={`${item.entityId ?? item.name}-${index}`}
                >
                  <BusinessItemTile
                    editKey={`ingredient-image:${item.entityId ?? index}`}
                    itemId={item.entityId}
                    src={item.image}
                    name={item.name}
                    size="var(--content-image-size)"
                    imageSize="var(--content-image-content-size)"
                  />
                  <CardDescription
                    editKey={`ingredient:${item.entityId ?? index}`}
                  >
                    {item.name || "Предмет не указан"}:{" "}
                    {item.requiredAmount == null
                      ? "Количество не указано"
                      : `× ${fmt(item.requiredAmount)}`}
                  </CardDescription>
                </li>
              ))}
            </ul>
          )}
        </EditableLayout>
        <Button
          editKey="action"
          variant="card-action"
          icon="levels"
          title={isUpgrade ? "Требования выбранного уровня" : "Уровни бизнеса"}
          className="business-entity-card__action"
          disabled={isUpgrade ? !levelCount : !upgrade}
          aria-label={
            isUpgrade
              ? `Требования для бизнеса «${business.title}», уровень ${resolvedLevel}`
              : `Уровни бизнеса «${business.title}»`
          }
          onClick={() => setDialog(isUpgrade ? "requirements" : "upgrades")}
        >
          {isUpgrade ? "Требования" : "Уровни"}
        </Button>
      </BaseCard>
      {dialog === "upgrades" && (
        <UpgradeDialog
          data={{ business, upgrade }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "requirements" && (
        <BusinessRequirementDialog
          business={business}
          requirement={{ requiredLevel: resolvedLevel }}
          onClose={() => setDialog(null)}
        />
      )}
    </CardEditScope>
  );
}
