import { useState } from "react";
import { StatTag } from "../../components/ui/StatTag/StatTag.jsx";
import { MutagenLabel } from "../../components/ui/MutagenLabel/MutagenLabel.jsx";
import { MenuItem } from "../../components/ui/MenuItem/MenuItem.jsx";
import { inventoryDisplayStats } from "./inventory.js";
import { CardActionMenu } from "../../components/ui/CardActionMenu/CardActionMenu.jsx";
import { BaseCard } from "../../components/ui/BaseCard/BaseCard.jsx";
import { CardTitle } from "../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../components/ui/CardDescription/CardDescription.jsx";
import { ImageCard } from "../../components/ui/ImageCard/ImageCard.jsx";
import { LockIndicator } from "../floors/LockIndicator/LockIndicator.jsx";
import { Pill } from "../../components/ui/Pill/Pill.jsx";
import { Icon } from "../../components/ui/Icon/Icon.jsx";
import { Divider } from "../../components/ui/Divider/Divider.jsx";
import { fmt } from "../../lib/format.js";
import "./InventoryItemCard.css";

const states = {
  owned: "В гардеробе",
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

export function InventoryDurability({ item }) {
  return (
    <MenuItem informational icon="wrench">
      Прочность: {fmt(item.durability)} / {fmt(item.durabilityMax)}
    </MenuItem>
  );
}

export function InventoryMenuDetails({ item }) {
  const activeMutagen =
    item.installedMutagen &&
    (item.type === "clothing_item" ||
      (item.mutagenActive ?? (item.equipped === true && !item.isBroken)));
  const hasLevel =
    Number.isSafeInteger(item.ownedLevel) &&
    item.ownedLevel >= 0 &&
    (item.maxLevel == null || item.ownedLevel <= item.maxLevel);
  return (
    <>
      {activeMutagen && (
        <MenuItem informational icon="flask-filled">
          {item.installedMutagen.name}
        </MenuItem>
      )}
      {hasLevel && (
        <MenuItem informational icon="levels">
          Уровень: {fmt(item.ownedLevel)}
          {Number.isSafeInteger(item.maxLevel) && item.maxLevel > 0
            ? ` / ${fmt(item.maxLevel)}`
            : null}
        </MenuItem>
      )}
    </>
  );
}

export function InventoryItemCard({
  item,
  onEquip,
  onAction,
  equipmentBusy = false,
}) {
  const [menuAnchor, setMenuAnchor] = useState(null);
  const [menuClosing, setMenuClosing] = useState(false);
  function finishCloseMenu() {
    setMenuAnchor(null);
    setMenuClosing(false);
    setPurchaseConfirmation(null);
    setRepairConfirmation(null);
  }
  function closeMenu() {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
      finishCloseMenu();
    else setMenuClosing(true);
  }
  const [repairConfirmation, setRepairConfirmation] = useState(null);
  const [purchaseConfirmation, setPurchaseConfirmation] = useState(null);
  const repairKey = `${item.type}:${item.id}:${item.repairCost}`;
  const confirmingRepair = repairConfirmation === repairKey;
  const locked = item.status === "locked";
  const durabilityKnown =
    item.type === "weapon" &&
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
  const purchaseKey = `${item.type}:${item.id}:${item.zoneId}:${price?.currency}:${price?.amount}`;
  const confirmingPurchase = purchaseConfirmation === purchaseKey;
  const status = locked ? (
    <LockIndicator
      className={room ? "inventory-room-status" : "inventory-item-lock"}
      variant="locked"
      label="Предмет недоступен"
    />
  ) : (
    !locked &&
    (item.equipped ||
      levelKnown ||
      item.isBroken ||
      item.installedMutagen ||
      item.status === "unknown") && (
      <div className={room ? "inventory-room-status" : "inventory-item-status"}>
        {item.installedMutagen && (
          <MutagenLabel
            status
            mutagen={item.installedMutagen}
            active={
              item.type === "clothing_item" ||
              (item.mutagenActive ?? (item.equipped === true && !item.isBroken))
            }
            inactiveReason={
              item.isBroken
                ? "Почините оружие, чтобы установленный мутаген снова работал."
                : item.type === "pet"
                  ? "Выберите питомца, чтобы мутаген добавлял бонусы к общим характеристикам."
                  : undefined
            }
          />
        )}
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
        {!levelKnown && !item.equipped && item.status === "unknown" && (
          <Pill size="xs" dot={false}>
            {states[item.status]}
          </Pill>
        )}
      </div>
    )
  );
  const hasActions = Boolean(
    durabilityKnown ||
    (item.status === "buyable" && price && onAction) ||
    (item.status === "owned" &&
      (onAction || (item.type === "weapon" && onEquip))),
  );
  const purchaseAction = item.status === "buyable" && price && onAction && (
    <MenuItem
      key="buy"
      warning={confirmingPurchase}
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
      onClick={() => {
        if (!confirmingPurchase) {
          setPurchaseConfirmation(purchaseKey);
          return;
        }
        closeMenu();
        onAction(item, "buy");
      }}
    >
      {confirmingPurchase ? "Точно?" : "Купить"} · {fmt(price.amount)}{" "}
      {currencies[price.currency]}
    </MenuItem>
  );
  const repairAction = item.status === "owned" &&
    (onAction || onEquip) &&
    item.type === "weapon" &&
    item.isBroken && (
      <MenuItem
        key="repair"
        warning={confirmingRepair}
        disabled={equipmentBusy || item.repairCost == null || !onAction}
        icon="pill"
        onClick={() => {
          if (!confirmingRepair) {
            setRepairConfirmation(repairKey);
            return;
          }
          closeMenu();
          onAction(item, "repair");
        }}
      >
        {confirmingRepair ? "Подтвердить ремонт" : "Починить"}
        {item.repairCost != null
          ? ` (${fmt(item.repairCost)})`
          : " — цена неизвестна"}
      </MenuItem>
    );
  const equipAction = item.status === "owned" &&
    (onAction || (item.type === "weapon" && onEquip)) && (
      <MenuItem
        key="equip"
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
        onClick={() => {
          closeMenu();
          if (onAction)
            onAction(item, item.equipped && !room ? "unequip" : "equip");
          else onEquip(item);
        }}
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
      </MenuItem>
    );
  const card = (
    <BaseCard
      as="article"
      padding="12"
      className="inventory-item-card"
      state={
        menuAnchor
          ? "selected"
          : item.status === "locked"
            ? "locked"
            : undefined
      }
      {...(hasActions
        ? {
            role: "button",
            tabIndex: 0,
            "aria-label": `Действия: ${item.name}`,
            "aria-haspopup": "dialog",
            "aria-expanded": Boolean(menuAnchor),
            onClick: (event) => {
              if (
                event.target.closest(
                  "button, a, input, select, textarea, [role=button]:not(.inventory-item-card)",
                )
              )
                return;
              if (menuAnchor) closeMenu();
              else setMenuAnchor(event.currentTarget);
            },
            onKeyDown: (event) => {
              if (
                event.target !== event.currentTarget ||
                !["Enter", " "].includes(event.key)
              )
                return;
              event.preventDefault();
              if (menuAnchor) closeMenu();
              else setMenuAnchor(event.currentTarget);
            },
          }
        : {})}
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
              {item.slotLabel ||
                item.setName ||
                (item.type === "ornament" && item.zoneId
                  ? `Зона ${item.zoneId}`
                  : typeLabels[item.type])}
            </CardDescription>
          )}
          {!room && <InventoryStats values={inventoryDisplayStats(item)} />}
        </div>
        {room && status}
      </div>
      {!room && !locked && status}
      {room && (
        <div className="inventory-item-details">
          <InventoryStats values={inventoryDisplayStats(item)} />
        </div>
      )}
    </BaseCard>
  );
  return (
    <>
      {card}
      {hasActions && menuAnchor && (
        <CardActionMenu
          anchor={menuAnchor}
          label={`Действия: ${item.name}`}
          onClose={closeMenu}
          closing={menuClosing}
          onClosed={finishCloseMenu}
        >
          <InventoryMenuDetails item={item} />
          {durabilityKnown && <InventoryDurability item={item} />}
          {(durabilityKnown || levelKnown || item.installedMutagen) &&
            (purchaseAction || repairAction || equipAction) && <Divider />}
          {purchaseAction}
          {repairAction}
          {equipAction}
        </CardActionMenu>
      )}
    </>
  );
}
