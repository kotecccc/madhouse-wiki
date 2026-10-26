import { StatTag } from "../../components/ui/StatTag/StatTag.jsx";
import { MutagenLabel } from "../../components/ui/MutagenLabel/MutagenLabel.jsx";
import { Button } from "../../components/ui/Button/Button.jsx";
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
  madness: ["madness", "Безумие"],
  aggression: ["aggression", "Агрессия"],
  rage: ["rage", "Ярость"],
  endurance: ["energy", "Выносливость"],
  maxHealth: ["health", "Здоровье"],
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
function InventoryStats({ values }) {
  const entries = Object.entries(values || {}).filter(
    ([key, value]) => stats[key] && Number.isFinite(value) && value !== 0,
  );
  if (!entries.length) return null;
  return (
    <div className="inventory-item-stats" aria-label="Характеристики">
      {entries.map(([key, value]) => {
        const label = `${key === "attackCooldownReductionSeconds" ? "−" : !key.startsWith("attackCooldown") && value > 0 ? "+" : ""}${fmt(value)}${key.startsWith("attackCooldown") ? " с" : ""}`;
        return (
          <StatTag
            key={key}
            icon={stats[key][0]}
            label={label}
            description={`${stats[key][1]}: ${label}`}
          />
        );
      })}
    </div>
  );
}

export function InventoryItemCard({
  item,
  onEquip,
  onAction,
  equipmentBusy = false,
}) {
  const locked = item.status === "locked";
  const durabilityKnown =
    Number.isFinite(item.durability) &&
    item.durability >= 0 &&
    Number.isFinite(item.durabilityMax) &&
    item.durabilityMax > 0 &&
    item.durability <= item.durabilityMax;
  const room = item.type === "room";
  const typeLabels = {
    room: "Комната",
    weapon: "Оружие",
    pet: "Питомец",
    clothing_item: "Одежда",
    ornament: "Тату",
  };
  const wornLabel = room
    ? "Выбрана"
    : item.type === "weapon"
      ? "В руке"
      : item.type === "pet"
        ? "Выбран"
        : "Надето";
  const equippedIcon = item.type === "weapon" ? "hand-stop" : "check";
  const levelKnown =
    item.ownedLevel != null &&
    item.maxLevel > 0 &&
    item.ownedLevel <= item.maxLevel;
  const maxed = levelKnown && item.ownedLevel === item.maxLevel;
  const price = item.facts?.purchasePrice;
  const status = locked ? (
    <span
      className={room ? "inventory-room-status" : "inventory-item-status"}
      role="img"
      aria-label="Предмет недоступен"
      title="Предмет недоступен"
    >
      <Icon type="lock" size="text" />
    </span>
  ) : (
    !locked &&
    (item.equipped ||
      levelKnown ||
      item.isBroken ||
      item.status !== "owned") && (
      <div className={room ? "inventory-room-status" : "inventory-item-status"}>
        {item.equipped && (
          <Pill size="xs" dot={false} variant="scheduled">
            <Icon type={equippedIcon} size="text" />
            {wornLabel}
          </Pill>
        )}
        {item.isBroken && (
          <Pill size="xs" dot={false} variant="locked">
            Сломан
          </Pill>
        )}
        {maxed && (
          <Pill size="xs" dot={false} variant="completed">
            Максимум
          </Pill>
        )}
        {levelKnown && !maxed && (
          <Pill size="xs" dot={false}>
            Ур. {item.ownedLevel}
          </Pill>
        )}
        {!levelKnown && !item.equipped && item.status !== "owned" && (
          <Pill size="xs" dot={false}>
            {states[item.status]}
          </Pill>
        )}
      </div>
    )
  );
  return (
    <BaseCard
      as="article"
      padding="12"
      className="inventory-item-card"
      state={item.status === "locked" ? "locked" : undefined}
    >
      {!room && locked && status}
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
          {!room && (
            <CardDescription size="xs">
              {durabilityKnown
                ? `Прочность: ${fmt(item.durability)} / ${fmt(item.durabilityMax)}`
                : item.slotLabel ||
                  item.setName ||
                  (item.type === "ornament" && item.zoneId
                    ? `Зона ${item.zoneId}`
                    : typeLabels[item.type])}
            </CardDescription>
          )}
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
        {room && status}
      </div>
      {!room && !locked && status}
      <div className="inventory-item-details">
        <InventoryStats values={inventoryDisplayStats(item)} />
        {item.installedMutagen && (
          <div className="inventory-item-mutagen">
            <MutagenLabel
              mutagen={item.installedMutagen}
              active={
                item.type === "clothing_item" ||
                (item.mutagenActive ??
                  (item.equipped === true && !item.isBroken))
              }
              inactiveReason={
                item.isBroken
                  ? "Почините оружие, чтобы установленный мутаген снова работал."
                  : item.type === "pet"
                    ? "Выберите питомца, чтобы мутаген добавлял бонусы к общим характеристикам."
                    : undefined
              }
            />
          </div>
        )}
      </div>
      {item.status === "buyable" && price && onAction && (
        <Button
          variant="primary"
          disabled={equipmentBusy}
          icon={
            price.currency === "gold"
              ? "coin"
              : price.currency === "pills"
                ? "pill"
                : price.currency === "stars"
                  ? "star"
                  : "banknote"
          }
          onClick={() => onAction(item, "buy")}
        >
          Купить · {fmt(price.amount)} {currencies[price.currency]}
        </Button>
      )}
      {item.status === "owned" &&
        (onAction || (item.type === "weapon" && onEquip)) && (
          <div className="inventory-item-actions">
            {item.type === "weapon" && item.isBroken && (
              <Button
                className="inventory-item-action"
                disabled={equipmentBusy || item.repairCost == null || !onAction}
                icon="pill"
                onClick={() => onAction(item, "repair")}
              >
                Починить
                {item.repairCost != null
                  ? ` (${fmt(item.repairCost)})`
                  : " — цена неизвестна"}
              </Button>
            )}
            <Button
              className="inventory-item-action"
              disabled={
                equipmentBusy ||
                (room && item.equipped) ||
                (item.type === "weapon" && item.isBroken && !item.equipped)
              }
              icon={
                item.equipped
                  ? room
                    ? "check"
                    : "close"
                  : item.type === "weapon"
                    ? "hand-stop"
                    : "check"
              }
              onClick={() =>
                onAction
                  ? onAction(item, item.equipped && !room ? "unequip" : "equip")
                  : onEquip(item)
              }
            >
              {room
                ? item.equipped
                  ? "Выбрана"
                  : "Выбрать"
                : item.type === "pet"
                  ? item.equipped
                    ? "Убрать"
                    : "Выбрать"
                  : item.equipped
                    ? "Снять"
                    : "Надеть"}
            </Button>
          </div>
        )}
    </BaseCard>
  );
}
