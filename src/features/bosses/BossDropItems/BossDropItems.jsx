import { CardEditScope } from "../../../components/ui/CardEditing/CardEditing.jsx";
import { EditableValue } from "../../../components/ui/CardEditing/EditableValue.jsx";
import { BusinessItemTile } from "../../businesses/BusinessItemTile/BusinessItemTile.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { editableTargetProps } from "../../../components/ui/EditableTarget/EditableTarget.js";
import "./BossDropItems.css";
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
  return (
    <div
      className={`boss-drop-items${compact ? " boss-drop-items--compact" : ""}`}
    >
      {items.map((item, index) => (
        <CardEditScope
          key={`${item.entityId}-${index}`}
          scope={`drop:${index}`}
        >
          <div
            {...editableTargetProps(Boolean(onSelectItem), "boss-drop-item")}
            key={`${item.entityId}-${index}`}
            role={onSelectItem ? "button" : undefined}
            tabIndex={onSelectItem ? 0 : undefined}
            aria-haspopup={onSelectItem ? "dialog" : undefined}
            title={onSelectItem ? "Настроить предмет" : undefined}
            onClick={
              onSelectItem
                ? (event) => {
                    event.stopPropagation();
                    onSelectItem(index, event.currentTarget, event);
                  }
                : undefined
            }
            onFocus={
              onSelectItem ? (event) => event.stopPropagation() : undefined
            }
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
            <BusinessItemTile
              editKey="image"
              itemId={item.entityId}
              src={item.image}
              name={item.name}
              size={
                itemOverrides[index]?.itemSize?.startsWith("--")
                  ? `var(${itemOverrides[index].itemSize})`
                  : itemOverrides[index]?.itemSize || itemSize
              }
              imageSize="var(--space-24)"
              loading={loading}
            />
            <CardDescription
              editKey="name"
              className="boss-drop-item-name"
              size={itemOverrides[index]?.textSize || textSize}
            >
              {item.name || `Предмет бизнеса №${item.entityId}`}
            </CardDescription>
            {Object.hasOwn(item, "requiredAmount") && (
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
      ))}
    </div>
  );
}
