import { inventoryDisplayStats } from "./inventory.js";
import { BaseCard } from "../../components/ui/BaseCard/BaseCard.jsx";
import { CardTitle } from "../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../components/ui/CardDescription/CardDescription.jsx";
import { ImageCard } from "../../components/ui/ImageCard/ImageCard.jsx";
import { Pill } from "../../components/ui/Pill/Pill.jsx";
import { Icon } from "../../components/ui/Icon/Icon.jsx";
import { ProgressBar } from "../../components/ui/ProgressBar/ProgressBar.jsx";
import { fmt } from "../../lib/format.js";
import "./InventoryItemCard.css";

const states = {
  owned: "В гардеробе",
  buyable: "Можно купить",
  locked: "Закрыто",
  unknown: "Статус неизвестен",
};
const stats = {
  madness: ["brain", "Безумие"],
  aggression: ["aggression", "Агрессия"],
  rage: ["rage", "Ярость"],
  endurance: ["madness", "Выносливость"],
  maxHealth: ["madness", "Здоровье"],
  baseDamage: ["sword", "Урон"],
  attackCooldownSeconds: ["timer", "Интервал атак"],
  attackCooldownReductionSeconds: ["timer", "Сокращение интервала"],
};
const currencies = {
  gold: "монет",
  dollar: "долларов",
  pills: "пилюль",
  stars: "звёзд",
};
function InventoryStats({ values, perLevel = false }) {
  const entries = Object.entries(values || {}).filter(
    ([key, value]) => stats[key] && Number.isFinite(value) && value !== 0,
  );
  if (!entries.length) return null;
  return (
    <div
      className="inventory-item-stats"
      aria-label={perLevel ? "Бонус за уровень" : "Характеристики"}
    >
      {entries.map(([key, value]) => (
        <span
          className="inventory-item-stat"
          key={key}
          title={`${stats[key][1]}${perLevel ? " за уровень" : ""}`}
        >
          <Icon type={stats[key][0]} />
          <CardTitle
            as="span"
            size="sm"
            aria-label={`${stats[key][1]}: ${value}${perLevel ? " за уровень" : ""}`}
          >
            {key === "attackCooldownReductionSeconds"
              ? "−"
              : !key.startsWith("attackCooldown") && value > 0
                ? "+"
                : ""}
            {fmt(value)}
            {key.startsWith("attackCooldown") ? " с" : ""}
            {perLevel ? " / ур." : ""}
          </CardTitle>
        </span>
      ))}
    </div>
  );
}

export function InventoryItemCard({ item }) {
  const locked = item.status === "locked";
  const durabilityKnown =
    Number.isFinite(item.durability) &&
    item.durability >= 0 &&
    Number.isFinite(item.durabilityMax) &&
    item.durabilityMax > 0 &&
    item.durability <= item.durabilityMax;
  const room = item.type === "room";
  const levelKnown =
    item.ownedLevel != null &&
    item.maxLevel > 0 &&
    item.ownedLevel <= item.maxLevel;
  const maxed = levelKnown && item.ownedLevel === item.maxLevel;
  const price = item.facts?.purchasePrice;
  return (
    <BaseCard
      as="article"
      padding="12"
      className="inventory-item-card"
      state={item.status === "locked" ? "locked" : undefined}
    >
      {locked && (
        <span
          className="inventory-item-status"
          role="img"
          aria-label="Предмет недоступен"
          title="Предмет недоступен"
        >
          <Icon type="lock" size="text" />
        </span>
      )}
      {room && (
        <ImageCard
          className="inventory-item-media"
          variant="landscape"
          src={item.image}
          alt={item.name}
        />
      )}
      <div
        className={`inventory-item-heading${room ? " inventory-item-heading--room" : ""}`}
      >
        {!room && <ImageCard src={item.image} alt={item.name} />}
        <div className="inventory-item-copy">
          <CardTitle as="h3" size="sm" title={item.name}>
            {item.name}
          </CardTitle>
          <CardDescription size="xs">
            {room
              ? "Комната"
              : levelKnown
                ? `${item.ownedLevel} из ${item.maxLevel} ур.`
                : "Оружие"}
          </CardDescription>
          {!room && durabilityKnown && (
            <div className="inventory-item-condition">
              <ProgressBar
                value={item.durability}
                max={item.durabilityMax}
                label="Остаток прочности оружия"
                valueText={`${item.durability} из ${item.durabilityMax}`}
              />
            </div>
          )}
        </div>
      </div>
      {!locked && (item.equipped || maxed || item.status !== "owned") && (
        <div className="inventory-item-status">
          {item.equipped && (
            <Pill size="xs" dot={false} variant="scheduled">
              <Icon type={room ? "check" : "hand-stop"} size="text" />
              {room ? "Выбрана" : "В руке"}
            </Pill>
          )}
          {maxed && (
            <Pill size="xs" dot={false} variant="completed">
              Максимум
            </Pill>
          )}
          {!maxed && !item.equipped && item.status !== "owned" && (
            <Pill size="xs" dot={false}>
              {states[item.status]}
            </Pill>
          )}
        </div>
      )}
      <InventoryStats values={inventoryDisplayStats(item)} />
      {price && item.status !== "owned" && item.status !== "locked" && (
        <div className="inventory-item-price">
          <Icon
            type={
              price.currency === "gold"
                ? "coin"
                : price.currency === "pills"
                  ? "pill"
                  : price.currency === "stars"
                    ? "star"
                    : "banknote"
            }
          />
          <CardTitle size="sm">
            Покупка · {fmt(price.amount)} {currencies[price.currency]}
          </CardTitle>
        </div>
      )}
    </BaseCard>
  );
}
