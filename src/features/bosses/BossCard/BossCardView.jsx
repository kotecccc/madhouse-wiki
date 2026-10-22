import { renderDisplayFields } from "../../../components/ui/CardEditing/DisplayFields.jsx";
import { BossStatus } from "./BossStatus.jsx";
import { departmentById } from "../../../model/knowledge-base.js";
import { bossDisplayFields } from "../../../lib/card-display-fields.js";
import { EditableLayout } from "../../../components/ui/CardEditing/EditableLayout.jsx";
import { useRef, useState } from "react";
import { useBossRewardReference } from "../useBossRewardReference.js";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { ItemCard } from "../../items/ItemCard/ItemCard.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { Modal } from "../../../components/ui/Modal/Modal.jsx";
import { fmt } from "../../../lib/format.js";
import { sortBossDrops } from "../../../lib/boss-drop-order.js";
import { BossDropItems } from "../BossDropItems/BossDropItems.jsx";
import { BossPortrait } from "../BossPortrait/BossPortrait.jsx";
import { trackProductEvent } from "../../analytics/analytics-client.js";
import { editableTargetProps } from "../../../components/ui/EditableTarget/EditableTarget.js";
import "./BossCardView.css";

const spacingSizes = new Set([
  "4",
  "8",
  "12",
  "16",
  "24",
  "32",
  "40",
  "48",
  "64",
]);
const spacingValue = (size) =>
  spacingSizes.has(String(size)) ? `var(--space-${size})` : undefined;

export function BossCardView({
  boss,
  as = "article",
  variant,
  titleAs = "strong",
  title = boss.name,
  className = "",
  showInfo = true,
  showStats = false,
  showDropList = true,
  action,
  actionText = "Весь дроп",
  actionSize,
  children,
  hasPortrait = true,
  imageLoading = "lazy",
  titleSize,
  infoSize,
  infoText,
  dropTextSize,
  dropItemSize,
  dropsCompact = false,
  dropItemOverrides = {},
  portraitProps = {},
  onSelectPart,
  cardPadding,
  contentGap,
  columnGap,
  displayFields,
  titleFields,
  descriptionFields,
  descriptionBreakBefore = [],
  titleDefaultFields = ["name"],
  statusSize = "sm",
  statusCompact = false,
  availabilitySize = "sm",
  showStatus = false,
  showAvailability = false,
  status = "unknown",
  raid,
}) {
  const cardRef = useRef(null);
  const referenceBoss = useBossRewardReference(boss, cardRef);
  const [showDrops, setShowDrops] = useState(false);
  const [portraitHeight, setPortraitHeight] = useState(92);
  const cardVariant = variant || "boss";
  const drops = sortBossDrops(boss.possibleDrops || []);
  const infoParts = [
    boss.requiredLevel != null && boss.rewardUntilLevel != null
      ? `Уровень ${fmt(boss.requiredLevel)}–${fmt(boss.rewardUntilLevel)}`
      : boss.requiredLevel != null
        ? `Уровень от ${fmt(boss.requiredLevel)}`
        : "Уровень не указан",
    showStats && boss.maxHp != null ? `HP ${fmt(boss.maxHp)}` : null,
    showStats && boss.damageMin != null && boss.damageMax != null
      ? `DMG ${fmt(boss.damageMin)}–${fmt(boss.damageMax)}`
      : null,
  ].filter(Boolean);
  const availableFields =
    displayFields ||
    bossDisplayFields(referenceBoss, departmentById[boss.departmentId] || {});
  const renderedTitle = Array.isArray(titleFields)
    ? renderDisplayFields(availableFields, titleFields)
    : title;
  const renderedInfo = Array.isArray(descriptionFields)
    ? renderDisplayFields(
        availableFields,
        descriptionFields,
        descriptionBreakBefore,
      )
    : (infoText ?? infoParts.join(" • "));
  const partProps = (part) =>
    onSelectPart
      ? {
          ...editableTargetProps(true),
          role: "button",
          "aria-haspopup": "dialog",
          title: "Настроить элемент",
          tabIndex: 0,
          onClick: (event) => {
            event.stopPropagation();
            onSelectPart(part, event.currentTarget, event);
          },
          onFocus: (event) => event.stopPropagation(),
          onKeyDown: (event) => {
            if (["Enter", " "].includes(event.key)) {
              event.preventDefault();
              event.stopPropagation();
              onSelectPart(part, event.currentTarget, event);
            }
          },
        }
      : {};
  const cardClass = [
    "boss-card-view",
    `boss-card-view--${cardVariant}`,
    !hasPortrait && "boss-card-view--no-portrait",
    (showStatus || showAvailability) && "boss-card-view--indicators",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  const outerGap = spacingValue(columnGap);
  const mainGap = spacingValue(contentGap);
  return (
    <BaseCard
      ref={cardRef}
      editKey="card"
      as={as}
      variant={cardVariant}
      padding={cardPadding}
      tabIndex={onSelectPart ? 0 : undefined}
      aria-label={
        onSelectPart ? "Карточка босса: нажмите для настройки" : undefined
      }
      onClick={
        onSelectPart
          ? (event) => onSelectPart("card", event.currentTarget, event)
          : undefined
      }
      onKeyDown={
        onSelectPart
          ? (event) => {
              if (
                event.target === event.currentTarget &&
                ["Enter", " "].includes(event.key)
              ) {
                event.preventDefault();
                onSelectPart("card", event.currentTarget, event);
              }
            }
          : undefined
      }
      {...editableTargetProps(Boolean(onSelectPart), cardClass)}
      style={{
        "--boss-portrait-height": `${portraitHeight}px`,
        ...(outerGap ? { gap: outerGap } : {}),
      }}
    >
      {hasPortrait && (
        <BossPortrait
          editKey="portrait"
          {...portraitProps}
          src={boss.image}
          alt={boss.name || ""}
          onHeight={setPortraitHeight}
          loading={imageLoading}
          {...partProps("portrait")}
        />
      )}
      <EditableLayout
        editKey="content-layout"
        className="boss-card-main"
        style={mainGap ? { gap: mainGap } : undefined}
      >
        <div className="boss-card-heading">
          <div className="boss-card-heading-title">
            <CardTitle
              editKey="title"
              composition={{
                fields: availableFields,
                defaultFields: titleDefaultFields,
              }}
              as={titleAs}
              size={titleSize}
              {...partProps("title")}
            >
              {renderedTitle || (onSelectPart ? "\u00a0" : "")}
            </CardTitle>
          </div>
          {(showStatus || showAvailability) && (
            <div className="boss-card-indicators">
              {showAvailability && (
                <BossStatus
                  availability="locked"
                  size={availabilitySize}
                  onSelect={
                    onSelectPart
                      ? (event) =>
                          onSelectPart(
                            "availability",
                            event.currentTarget,
                            event,
                          )
                      : undefined
                  }
                />
              )}
              {showStatus && (
                <BossStatus
                  size={statusSize}
                  compact={statusCompact}
                  raid={raid}
                  status={
                    ["scheduled", "active", "completed"].includes(status)
                      ? status
                      : "scheduled"
                  }
                  onSelect={
                    onSelectPart
                      ? (event) =>
                          onSelectPart("status", event.currentTarget, event)
                      : undefined
                  }
                />
              )}
            </div>
          )}
        </div>
        {showInfo && (
          <CardDescription
            editKey="info"
            composition={{
              fields: availableFields,
              defaultFields: [
                "accessLevel",
                ...(showStats ? ["hp", "damage"] : []),
              ],
            }}
            size={infoSize}
            {...partProps("info")}
          >
            {renderedInfo || (onSelectPart ? "\u00a0" : "")}
          </CardDescription>
        )}
        {children}
        {showDropList &&
          (boss.dropItems?.length ? (
            <BossDropItems
              items={boss.dropItems}
              loading={imageLoading}
              textSize={dropTextSize}
              itemSize={dropItemSize}
              compact={dropsCompact}
              itemOverrides={dropItemOverrides}
              onSelectItem={
                onSelectPart
                  ? (index, anchor, event) =>
                      onSelectPart(`drop:${index}`, anchor, event)
                  : undefined
              }
            />
          ) : (
            <CardDescription editKey="drops-empty" {...partProps("drops")}>
              Добыча не указана
            </CardDescription>
          ))}
      </EditableLayout>
      {action ?? (
        <Button
          editKey="action"
          variant="card-action"
          icon="loot"
          aria-label={`${actionText}: ${boss.name}`}
          title={actionText}
          {...editableTargetProps(
            Boolean(onSelectPart),
            "boss-all-drops-button",
          )}
          size={actionSize}
          aria-haspopup="dialog"
          onFocus={
            onSelectPart ? (event) => event.stopPropagation() : undefined
          }
          onClick={(event) => {
            if (onSelectPart) {
              event.stopPropagation();
              onSelectPart("action", event.currentTarget, event);
              return;
            }
            trackProductEvent("boss_details_open", {
              section: "bosses",
              feature: "boss_drops",
              subject: boss.id,
            });
            setShowDrops(true);
          }}
        >
          {actionText}
        </Button>
      )}
      {showDrops && (
        <Modal
          title={`Дроп: ${boss.name}`}
          titleId={`boss-drops-title-${boss.id}`}
          width="560px"
          className="boss-drops-dialog"
          contentVariant="inset"
          onClose={() => setShowDrops(false)}
        >
          <>
            {drops.length ? (
              <ul className="boss-drops-list">
                {drops.map((drop, index) => (
                  <ItemCard
                    key={`${drop.type}-${drop.entityId ?? index}`}
                    item={drop}
                  />
                ))}
              </ul>
            ) : (
              <CardDescription>Сведения о дропе не указаны.</CardDescription>
            )}
          </>
        </Modal>
      )}
    </BaseCard>
  );
}
