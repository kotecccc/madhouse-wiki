import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { fmt } from "../../../lib/format.js";
import "./WorkStashCard.css";

export function WorkStashCard({ work, stash }) {
  const set = work.stashSet;
  if (!set?.ingredients?.length) return null;
  const personal = String(stash?.setId) === String(set.setId) ? stash : null;
  return (
    <BaseCard variant="floor-data" className="work-stash-card">
      <div
        className="work-stash-items"
        role="list"
        aria-label="Элементы набора работы"
      >
        {set.ingredients.map((item) => {
          const state = personal?.ingredients?.find(
            (value) => String(value.ingredientId) === String(item.ingredientId),
          );
          const name =
            item.name || item.title || `Элемент ${item.ingredientId}`;
          const locked = state?.unlocked === false;
          const purchaseLocked = state?.purchaseUnlocked === false;
          return (
            <div
              className="work-stash-item"
              role="listitem"
              key={item.ingredientId}
            >
              <ImageCard src={item.imageUrl} alt={name} title={name} />
              <CardDescription
                size="sm"
                title={`${name}: в инвентаре ${state?.quantity == null ? "неизвестно" : fmt(state.quantity)}`}
              >
                {state?.quantity == null ? "—" : fmt(state.quantity)}
              </CardDescription>
              {(locked || purchaseLocked) && (
                <span
                  title={
                    locked
                      ? "Элемент не разблокирован"
                      : "Покупка не разблокирована"
                  }
                  aria-label={
                    locked
                      ? "Элемент не разблокирован"
                      : "Покупка не разблокирована"
                  }
                >
                  <Icon type="lock" size="text" />
                </span>
              )}
            </div>
          );
        })}
      </div>
    </BaseCard>
  );
}
