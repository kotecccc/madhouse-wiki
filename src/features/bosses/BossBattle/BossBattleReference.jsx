import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { Disclosure } from "../../../components/ui/Disclosure/Disclosure.jsx";
import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { Pill } from "../../../components/ui/Pill/Pill.jsx";
import { BossCardVariant } from "../BossCard/BossCardVariant.jsx";
import { sortBossDrops } from "../../../lib/boss-drop-order.js";
import { fmt } from "../../../lib/format.js";
import { bossBattleLoot } from "./boss-battle-reference.js";
import "./BossBattleReference.css";

function sortLootRows(rows) {
  const byItem = new Map(rows.map((row) => [row.item, row]));
  return sortBossDrops(rows.map((row) => row.item)).map((item) =>
    byItem.get(item),
  );
}

function LootGrid({ rows, showReceived }) {
  return (
    <div className="boss-battle-loot-grid">
      {sortLootRows(rows).map(({ key, item, amount, received }) => (
        <BaseCard key={key} className="boss-battle-loot-tile">
          <ImageCard
            src={item.image}
            alt={item.name || "Предмет босса"}
            title={item.name || "Предмет босса"}
          />
          <CardTitle size="sm" title={item.name}>
            {item.name || "Название не указано"}
          </CardTitle>
          {showReceived && received && (
            <Pill variant="completed" size="xs" dot={false}>
              Получено{amount != null ? ` ×${fmt(amount)}` : ""}
            </Pill>
          )}
        </BaseCard>
      ))}
    </div>
  );
}

export function BossBattleSummary({ boss }) {
  return (
    <BossCardVariant
      preset="boss-battle"
      variant="floor-data"
      boss={{ ...boss.reference, name: boss.name }}
    />
  );
}

export function BossBattleDrops({ boss, battle }) {
  const rows = bossBattleLoot(boss.reference, battle);
  return (
    <Disclosure
      title="Дроп босса"
      count={fmt(rows.length)}
      countLabel={`Предметов: ${rows.length}`}
    >
      {rows.length ? (
        <LootGrid rows={rows} showReceived />
      ) : (
        <CardDescription>Сведения о предметах не указаны.</CardDescription>
      )}
    </Disclosure>
  );
}

export function BossBattleReceivedDrops({ boss, battle }) {
  const rows = bossBattleLoot(boss.reference, battle).filter(
    (row) => row.received === true,
  );
  return (
    <BaseCard className="boss-battle-received-drops">
      <CardTitle>Полученный дроп</CardTitle>
      {rows.length ? (
        <LootGrid rows={rows} showReceived />
      ) : (
        <CardDescription>Нет данных о выпавших предметах.</CardDescription>
      )}
      {battle?.currencyRewards?.map(({ type, amount }) => {
        const reward = {
          gold: ["coin", "Монеты"],
          pills: ["pill", "Пилюли"],
          dollar: ["banknote", "Купюры"],
          exp: [null, "Опыт"],
        }[type];
        if (!reward) return null;
        const [icon, label] = reward;
        return (
          <CardDescription key={type}>
            {icon && <Icon type={icon} size="small" />}
            {label}: {fmt(amount)}
          </CardDescription>
        );
      })}
    </BaseCard>
  );
}
