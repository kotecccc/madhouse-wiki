import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";
import { Disclosure } from "../../../components/ui/Disclosure/Disclosure.jsx";
import { LockIndicator } from "../../floors/LockIndicator/LockIndicator.jsx";
import { Pill } from "../../../components/ui/Pill/Pill.jsx";
import { fmt } from "../../../lib/format.js";
import "./WorkStashCard.css";

const statLabels = {
  madness: "Безумие",
  aggression: "Агрессия",
  rage: "Ярость",
  endurance: "Выносливость",
  maxHealth: "Здоровье",
  baseDamage: "Урон",
  critChance: "Критический шанс",
  attackCooldownSeconds: "Интервал атак",
  attackCooldownReductionSeconds: "Сокращение интервала атак",
};

function bonusDescription(rewards = {}) {
  return (rewards.effects || [])
    .map(({ stat, amount }) => {
      const sign = amount < 0 ? "−" : "+";
      return `${statLabels[stat] || stat} ${sign}${fmt(Math.abs(amount))}`;
    })
    .join(" · ");
}

export function WorkStashCard({ work, stash }) {
  const set = work.stashSet;
  if (!set?.ingredients?.length) return null;
  const personal = String(stash?.setId) === String(set.setId) ? stash : null;
  const name = set.name || set.title || "Набор";
  const total = set.ingredients.length;
  const quantities = set.ingredients.map(
    (item) =>
      personal?.ingredients?.find(
        (value) => String(value.ingredientId) === String(item.ingredientId),
      )?.quantity,
  );
  const collected = quantities.filter((quantity) => quantity > 0).length;
  const collectionKnown = quantities.every((quantity) => quantity != null);
  const collectionStatus = collectionKnown
    ? `${collected} / ${total}`
    : `— / ${total}`;
  return (
    <Disclosure
      title={name}
      titleSize="sm"
      descriptionSize="xs"
      description={bonusDescription(set.rewards) || "Бонусы не указаны"}
      leading={
        <ImageCard
          src={set.previewImageUrl || set.imageUrl}
          alt=""
          size={48}
          imageSize={32}
        />
      }
      status={
        <Pill
          variant={
            collectionKnown && collected === total ? "completed" : "unknown"
          }
          size="sm"
          dot={false}
          title="Статус сбора набора"
          aria-label={`Собрано элементов набора: ${collectionStatus}`}
        >
          {collectionStatus}
        </Pill>
      }
    >
      <div
        className="work-stash-items"
        role="list"
        aria-label="Элементы набора работы"
      >
        {set.ingredients.map((item) => {
          const state = personal?.ingredients?.find(
            (value) => String(value.ingredientId) === String(item.ingredientId),
          );
          const itemName =
            item.name || item.title || `Элемент ${item.ingredientId}`;
          const locked = state?.unlocked === false;
          return (
            <div
              className="work-stash-item"
              role="listitem"
              key={item.ingredientId}
            >
              <ImageCard
                src={item.imageUrl}
                alt={itemName}
                title={itemName}
                size={40}
                imageSize={24}
              />
              <CardDescription
                size="sm"
                title={`${itemName}: в инвентаре ${state?.quantity == null ? "неизвестно" : fmt(state.quantity)}`}
              >
                {state?.quantity == null ? "—" : fmt(state.quantity)}
              </CardDescription>
              {locked && (
                <LockIndicator
                  variant="locked"
                  label="Элемент не разблокирован"
                />
              )}
            </div>
          );
        })}
      </div>
    </Disclosure>
  );
}
