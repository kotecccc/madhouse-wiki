import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { BusinessItemTile } from "../BusinessItemTile/BusinessItemTile.jsx";
import { fmt } from "../../../lib/format.js";
import "./BusinessItemDropList.css";

export function BusinessItemDropList({ items, bossName, loading }) {
  return (
    <ul
      className="business-item-drop-list boss-card-business-items-right"
      aria-label={`Предметы для босса ${bossName}`}
    >
      {items.map((item) => (
        <li key={item.entityId}>
          <CardDescription
            as="span"
            size="sm"
            aria-label={
              item.requiredAmount == null
                ? "Необходимое количество пока неизвестно"
                : `Нужно собрать ${fmt(item.requiredAmount)} предметов`
            }
          >
            ×{item.requiredAmount == null ? "—" : fmt(item.requiredAmount)}
          </CardDescription>
          <BusinessItemTile
            itemId={item.entityId}
            name={item.name}
            size={64}
            imageSize={48}
            loading={loading}
          />
        </li>
      ))}
    </ul>
  );
}
