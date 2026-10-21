import { BusinessItemTile } from "../../businesses/BusinessItemTile/BusinessItemTile.jsx";
import "./BossDropItems.css";
export function BossDropItems({ items }) {
  if (!items?.length) return null;
  return (
    <div className="boss-drop-items">
      {items.map((item, index) => (
        <div className="boss-drop-item" key={`${item.entityId}-${index}`}>
          <BusinessItemTile
            itemId={item.entityId}
            name={item.name}
            size={36}
            imageSize={32}
          />
          <span className="boss-drop-item-name">
            {item.name || `Предмет бизнеса №${item.entityId}`}
          </span>
          {Object.hasOwn(item, "requiredAmount") && (
            <strong className="boss-drop-required-count" aria-label={item.requiredAmount == null ? "Необходимое количество пока неизвестно" : `Нужно собрать ${item.requiredAmount} предметов`}>
              ×{item.requiredAmount ?? "—"}
            </strong>
          )}
        </div>
      ))}
    </div>
  );
}
