import "./UpgradeDialog.css";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";
import { Modal } from "../../../components/ui/Modal/Modal.jsx";
import { bossById } from "../../../model/knowledge-base.js";
import { fmt } from "../../../lib/format.js";
import { BusinessItemTile } from "../BusinessItemTile/BusinessItemTile.jsx";

const sameId = (left, right) =>
  left != null && right != null && String(left) === String(right);

function bossesForItem(item) {
  return Object.values(bossById).filter((boss) =>
    (boss.dropItems || []).some((drop) => sameId(drop.entityId, item.entityId)),
  );
}

export function UpgradeDialog({ data, onClose }) {
  const { business, upgrade } = data;
  const items = upgrade?.items || [];
  const levelCount = Math.max(
    0,
    ...items.map((item) => item.levels?.length || 0),
  );

  return (
    <Modal
      className="business-upgrade-dialog"
      title={business.title || "Бизнес"}
      titleId="upgrade-title"
      onClose={onClose}
      width={680}
    >
      {!upgrade ? (
        <p className="business-upgrade-empty">
          Данные об улучшениях отсутствуют.
        </p>
      ) : (
        <div className="business-upgrade-level-grid">
          <CardDescription>
            Источник: данные пользователя, 20.10.2026. Указаны количества
            предметов для каждого улучшения.
          </CardDescription>
          {(upgrade.sourceTotals ?? [])
            .filter((total) => !total.matches)
            .map((total) => (
              <p className="business-upgrade-empty" key={total.itemName}>
                «{total.itemName}»: исходный итог {total.declared}, сумма по
                уровням {total.computed}.
              </p>
            ))}
          {Array.from({ length: levelCount }, (_, levelIndex) => (
            <BaseCard
              as="section"
              variant="upgrade-level"
              className="business-upgrade-level-card"
              key={levelIndex}
              aria-label={`Уровень ${levelIndex + 1}`}
            >
              <h3 className="business-upgrade-level-heading">
                Уровень {levelIndex + 1}
              </h3>
              <div className="business-upgrade-level-items">
                {items.map((item, itemIndex) => {
                  const matches = bossesForItem(item);
                  const count = item.levels?.[levelIndex];
                  return (
                    <BaseCard
                      as="article"
                      variant="floor-data"
                      className="business-upgrade-item-card"
                      key={`${item.entityId ?? item.name}-${itemIndex}`}
                    >
                      {matches.length > 0 ? (
                        <div className="business-upgrade-bosses">
                          {matches.map((boss) => (
                            <div
                              className="business-upgrade-boss"
                              key={boss.id}
                            >
                              <ImageCard
                                src={boss.image || ""}
                                alt={boss.image ? boss.name : ""}
                                label={
                                  boss.image ? undefined : "Портрет отсутствует"
                                }
                                size={48}
                              />
                              <CardTitle className="business-upgrade-boss-name">
                                {boss.name}
                              </CardTitle>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      <div className="business-upgrade-item-details">
                        <CardDescription className="business-upgrade-item-name">
                          {item.name || "Предмет не указан"}
                        </CardDescription>
                        {item.entityId != null ? (
                          <BusinessItemTile
                            itemId={item.entityId}
                            name={item.name}
                            labelled={false}
                            size={40}
                          />
                        ) : null}
                      </div>
                      <strong className="business-upgrade-item-count">
                        {count == null ? "—" : fmt(count)}
                      </strong>
                    </BaseCard>
                  );
                })}
              </div>
            </BaseCard>
          ))}
        </div>
      )}
    </Modal>
  );
}
