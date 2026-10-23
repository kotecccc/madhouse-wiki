import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { ItemCard } from "../../items/ItemCard/ItemCard.jsx";
import { Pill } from "../../../components/ui/Pill/Pill.jsx";
import { knowledgeBase } from "virtual:madhouse-catalogue";
import { fmt } from "../../../lib/format.js";
import "./NextLevelSection.css";

export function NextLevelSection({ playerLevel }) {
  const hasPlayerLevel = Number.isSafeInteger(playerLevel) && playerLevel > 0;
  const nextLevel = playerLevel + 1;
  const hasNextLevel = hasPlayerLevel && Number.isSafeInteger(nextLevel);
  const items = hasNextLevel
    ? (knowledgeBase.wardrobeItems || []).filter(
        (item) => item.requiredLevel === nextLevel,
      )
    : [];

  return (
    <BaseCard
      as="article"
      variant="floor-data"
      className="next-level-section"
      aria-labelledby="next-level-title"
    >
      <div className="next-level-heading">
        <CardTitle as="h2" id="next-level-title">
          Следующий уровень
        </CardTitle>
        {hasNextLevel ? (
          items.length > 0 ? (
            <CardDescription>
              Предметы, которые откроются на уровне {fmt(nextLevel)}
            </CardDescription>
          ) : (
            <Pill variant="unknown" dot={false}>
              Нет предметов
            </Pill>
          )
        ) : (
          <CardDescription>
            Уровень персонажа не передан этой сессией.
          </CardDescription>
        )}
      </div>
      {hasNextLevel && items.length > 0 && (
        <ul className="next-level-items">
          {items.map((item) => (
            <ItemCard key={item.id} item={item} showAllStats />
          ))}
        </ul>
      )}
    </BaseCard>
  );
}
