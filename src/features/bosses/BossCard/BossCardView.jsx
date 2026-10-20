import { useState } from "react";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { ItemCard } from "../../items/ItemCard/ItemCard.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { Modal } from "../../../components/ui/Modal/Modal.jsx";
import { fmt } from "../../../lib/format.js";
import { sortBossDrops } from "../../../lib/boss-drop-order.js";
import { BossDropItems } from "../BossDropItems/BossDropItems.jsx";
import { BossPortrait } from "../BossPortrait/BossPortrait.jsx";
import "./BossCardView.css";

export function BossCardView({
  boss,
  as = "article",
  variant,
  className = "",
}) {
  const [showDrops, setShowDrops] = useState(false);
  const [portraitHeight, setPortraitHeight] = useState(92);
  const drops = sortBossDrops(boss.possibleDrops || []);
  const cardClass = `boss-card-view ${className}`.trim();
  return (
    <BaseCard
      as={as}
      variant={variant}
      className={cardClass}
      style={{ "--boss-portrait-height": `${portraitHeight}px` }}
    >
      <BossPortrait
        src={boss.image}
        alt={boss.name || ""}
        onHeight={setPortraitHeight}
      />
      <div className="boss-card-main">
        <CardTitle>{boss.name}</CardTitle>
        <CardDescription>
          {boss.requiredLevel != null && boss.rewardUntilLevel != null
            ? `Уровень ${fmt(boss.requiredLevel)}–${fmt(boss.rewardUntilLevel)}`
            : boss.requiredLevel != null
              ? `Уровень от ${fmt(boss.requiredLevel)}`
              : "Уровень не указан"}
        </CardDescription>
        {boss.dropItems?.length ? (
          <BossDropItems items={boss.dropItems} />
        ) : (
          <CardDescription>Добыча не указана</CardDescription>
        )}
      </div>
      <Button
        variant="card-action"
        icon="loot"
        aria-label={`Весь дроп: ${boss.name}`}
        title="Весь дроп"
        className="boss-all-drops-button"
        aria-haspopup="dialog"
        onClick={() => setShowDrops(true)}
      >
        Весь дроп
      </Button>
      {showDrops && (
        <Modal
          title={`Дроп: ${boss.name}`}
          titleId={`boss-drops-title-${boss.id}`}
          width="560px"
          contentBackground="deep"
          className="boss-drops-dialog"
          onClose={() => setShowDrops(false)}
        >
          <>
            {drops.length ? (
              <ul className="boss-drops-list">
                {drops.map((drop, index) => (
                  <ItemCard
                    key={`${drop.type}-${drop.entityId ?? index}`}
                    item={drop}
                  />
                ))}
              </ul>
            ) : (
              <CardDescription>Сведения о дропе не указаны.</CardDescription>
            )}
          </>
        </Modal>
      )}
    </BaseCard>
  );
}
