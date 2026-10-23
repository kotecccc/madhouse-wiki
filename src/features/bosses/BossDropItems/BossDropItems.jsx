import { CardEditScope } from "../../../components/ui/CardEditing/CardEditing.jsx";
import { EditableValue } from "../../../components/ui/CardEditing/EditableValue.jsx";
import { BusinessItemTile } from "../../businesses/BusinessItemTile/BusinessItemTile.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { editableTargetProps } from "../../../components/ui/EditableTarget/EditableTarget.js";
import "./BossDropItems.css";

export function BossDropItem({
  item,
  index,
  itemSize,
  textSize,
  itemOverrides = {},
  onSelectItem,
  placement = "left",
  loading = "lazy",
}) {
  const override = itemOverrides[index] || {};
  const isRight = placement === "right";
  const size = override.itemSize?.startsWith("--")
    ? `var(${override.itemSize})`
    : override.itemSize ||
      itemSize ||
      (isRight ? "var(--space-64)" : "var(--space-32)");
  return (
    <CardEditScope scope={`drop:${index}`}>
      <div
        {...editableTargetProps(
          Boolean(onSelectItem),
          `boss-drop-item${isRight ? " boss-drop-item--right" : ""}`,
        )}
        role={onSelectItem ? "button" : undefined}
        tabIndex={onSelectItem ? 0 : undefined}
        aria-haspopup={onSelectItem ? "dialog" : undefined}
        title={onSelectItem ? "Настроить предмет бизнеса" : undefined}
        onClick={
          onSelectItem
            ? (event) => {
                event.stopPropagation();
                onSelectItem(index, event.currentTarget, event);
              }
            : undefined
        }
        onFocus={onSelectItem ? (event) => event.stopPropagation() : undefined}
        onKeyDown={
          onSelectItem
            ? (event) => {
                if (["Enter", " "].includes(event.key)) {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectItem(index, event.currentTarget, event);
                }
              }
            : undefined
        }
      >
        {isRight && (
          <EditableValue
            as="strong"
            editKey="required"
            className="boss-drop-required-count"
            aria-label={
              item.requiredAmount == null
                ? "Необходимое количество пока не указано"
                : `Нужно собрать ${item.requiredAmount} предметов`
            }
          >
            {`×${item.requiredAmount ?? "—"}`}
          </EditableValue>
        )}
        <BusinessItemTile
          editKey="image"
          itemId={item.entityId}
          src={item.image}
          name={item.name}
          size={size}
          imageSize={isRight ? "var(--space-48)" : "var(--space-24)"}
          loading={loading}
        />
        {!isRight && (
          <CardDescription
            className="boss-drop-item-name"
            size={override.textSize || textSize}
          >
            {item.name || `Предмет бизнеса №${item.entityId}`}
          </CardDescription>
        )}
        {!isRight && Object.hasOwn(item, "requiredAmount") && (
          <EditableValue
            as="strong"
            editKey="required"
            className="boss-drop-required-count"
            aria-label={
              item.requiredAmount == null
                ? "Необходимое количество пока неизвестно"
                : `Нужно собрать ${item.requiredAmount} предметов`
            }
          >
            {`×${item.requiredAmount ?? "—"}`}
          </EditableValue>
        )}
      </div>
    </CardEditScope>
  );
}

export function BossDropItems({
  items,
  itemSize = "var(--space-32)",
  textSize,
  itemOverrides = {},
  onSelectItem,
  compact = false,
  loading = "lazy",
}) {
  if (!items?.length) return null;
  const visibleItems = items
    .map((item, index) => ({ item, index }))
    .filter(({ index }) => itemOverrides[index]?.position !== "right");
  if (!visibleItems.length) return null;
  return (
    <div
      className={`boss-drop-items${compact ? " boss-drop-items--compact" : ""}`}
    >
      {visibleItems.map(({ item, index }) => (
        <BossDropItem
          key={`${item.entityId}-${index}`}
          item={item}
          index={index}
          itemSize={itemSize}
          textSize={textSize}
          itemOverrides={itemOverrides}
          onSelectItem={onSelectItem}
          loading={loading}
        />
      ))}
    </div>
  );
}
