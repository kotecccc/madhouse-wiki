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
            size="100cqh"
            imageSize="max(0px, calc(100cqh - 4px))"
          />
          <span className="boss-drop-item-name">
            {item.name || `Предмет бизнеса №${item.entityId}`}
          </span>
        </div>
      ))}
    </div>
  );
}
