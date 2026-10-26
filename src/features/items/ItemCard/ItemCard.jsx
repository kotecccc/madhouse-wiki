import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { fmt } from "../../../lib/format.js";
import "./ItemCard.css";

const types = {
  activity_item: "Предмет бизнеса",
  mutagen: "Мутаген",
  room: "Комната",
  clothing_item: "Предмет одежды",
  weapon: "Оружие",
  pet: "Питомец",
  stash_ingredient: "Ингредиент тайника",
  ornament: "Украшение",
};
const statLabels = {
  madness: "Безумие",
  aggression: "Агрессия",
  rage: "Ярость",
  endurance: "Выносливость",
  maxHealth: "Здоровье",
  baseDamage: "Урон",
  attackCooldownSeconds: "Интервал атак",
  attackCooldownReductionSeconds: "Интервал атак",
};
const currencies = {
  gold: ["монета", "монеты", "монет"],
  dollar: ["доллар", "доллара", "долларов"],
  pills: ["пилюля", "пилюли", "пилюль"],
  stars: ["звезда", "звезды", "звёзд"],
};
const plural = new Intl.PluralRules("ru");
function StatList({ stats, perLevel = false }) {
  const entries = Object.entries(stats || {}).filter(
    ([, value]) => value !== 0,
  );
  if (!entries.length) return null;
  return (
    <dl
      className="item-card-stats"
      aria-label={perLevel ? "За каждый уровень" : "Характеристики"}
    >
      {entries.map(([key, value]) => {
        const isInterval = key.startsWith("attackCooldown");
        const sign =
          key === "attackCooldownReductionSeconds"
            ? "−"
            : !isInterval && value > 0
              ? "+"
              : "";
        return (
          <div key={key}>
            <dt>{statLabels[key] || key}</dt>
            <dd>
              {sign}
              {fmt(value)}
              {isInterval ? " с" : ""}
              {perLevel ? " / ур." : ""}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
function Price({ label, value }) {
  const unit =
    value &&
    currencies[value.currency]?.[
      { one: 0, few: 1, many: 2, other: 2 }[plural.select(value.amount)]
    ];
  return value ? (
    <div>
      <dt>{label}</dt>
      <dd>
        {fmt(value.amount)} {unit}
      </dd>
    </div>
  ) : null;
}

// Standalone catalogue card, also reused for a boss's possible loot.
export function ItemCard({
  item,
  as = "li",
  showAllStats = false,
  children,
  state,
  hidePrice = false,
}) {
  const facts = item.facts;
  const isWeaponOrPet = item.type === "weapon" || item.type === "pet";
  const sourceStats = facts?.stats || {};
  const stats =
    isWeaponOrPet && !showAllStats
      ? Object.fromEntries(
          Object.entries(sourceStats).filter(
            ([key]) => !key.startsWith("attackCooldown"),
          ),
        )
      : sourceStats;
  const perLevelStats =
    isWeaponOrPet && !showAllStats ? {} : facts?.perLevelStats || {};
  const knownZeroStats =
    Object.keys(stats).length > 0 &&
    Object.values(stats).every((value) => value === 0);
  const hasPrice = facts?.installPrice || facts?.purchasePrice;
  const hasStats =
    Object.keys(stats).length > 0 ||
    Object.values(perLevelStats).some((value) => value !== 0);
  return (
    <BaseCard
      as={as}
      state={state}
      variant="floor-data"
      className={`item-card${hasStats ? " item-card--with-stats" : ""}`}
    >
      <ImageCard
        src={item.image}
        alt={item.name || "Предмет"}
        size="var(--content-image-size)"
        imageSize="var(--content-image-content-size)"
      />
      <div className="item-card-copy">
        <CardTitle>{item.name || "Название не указано"}</CardTitle>
        <CardDescription>
          {item.slotLabel || types[item.type] || "Предмет"}
        </CardDescription>
        {hasPrice && !hidePrice && (
          <dl className="item-card-prices" aria-label="Стоимость">
            <Price label="Установка" value={facts.installPrice} />
            <Price label="Покупка" value={facts.purchasePrice} />
          </dl>
        )}
        {item.amount != null && (
          <CardDescription>Количество: {fmt(item.amount)}</CardDescription>
        )}
        {children}
      </div>
      {hasStats && (
        <div className="item-card-effects">
          <StatList stats={stats} />
          {knownZeroStats && (
            <CardDescription>Без бонусов к характеристикам</CardDescription>
          )}
          <StatList stats={perLevelStats} perLevel />
        </div>
      )}
    </BaseCard>
  );
}
