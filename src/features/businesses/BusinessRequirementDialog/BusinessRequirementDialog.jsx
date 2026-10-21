import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";
import { Modal } from "../../../components/ui/Modal/Modal.jsx";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import {
  bossById,
  getBusinessUpgrade,
  getDepartmentBosses,
} from "../../../model/knowledge-base.js";
import {
  getBusinessUpgradeTotals,
  findItemBosses,
} from "../../../lib/business-upgrades.js";
import { BusinessItemTile } from "../BusinessItemTile/BusinessItemTile.jsx";
import { fmt } from "../../../lib/format.js";
import "./BusinessRequirementDialog.css";

export function BusinessRequirementDialog({ business, requirement, onClose }) {
  const level = requirement?.requiredLevel ?? requirement?.required;
  const upgrade = getBusinessUpgrade(business?.id);
  const totals = getBusinessUpgradeTotals(upgrade, level);
  const groups = new Map();
  if (upgrade) {
    for (const item of totals) {
      const matches = findItemBosses(Object.values(bossById), item.entityId);
      for (const boss of matches) {
        const group = groups.get(boss.id) ?? { ...boss, dropItems: [] };
        group.dropItems.push(item);
        groups.set(boss.id, group);
      }
      if (!matches.length)
        groups.set(`item:${item.entityId}`, {
          id: `item:${item.entityId}`,
          name: item.name,
          dropItems: [item],
        });
    }
  } else if (business) {
    for (const boss of getDepartmentBosses(business.departmentId))
      groups.set(boss.id, boss);
  }
  const bosses = [...groups.values()];
  const disagreements = (upgrade?.sourceTotals ?? []).filter(
    (total) => !total.matches && total.lastLevel <= level,
  );
  return (
    <Modal
      title={`Что собирать для «${business?.title || "Бизнес"}»${level != null ? `, уровень ${fmt(level)}` : ""}?`}
      titleId="business-requirements-title"
      width={560}
      onClose={onClose}
    >
      <div className="business-requirements-content">
        <ul className="business-requirements-sources">
          {bosses.map((boss) => (
            <BaseCard
              as="li"
              variant="floor-data"
              className="business-requirements-source"
              key={boss.id}
            >
              <ImageCard
                src={boss.image}
                alt={boss.name}
                size={58}
                imageSize="100%"
              />
              <div className="business-requirements-copy">
                <CardTitle>{boss.name}</CardTitle>
                <CardDescription>
                  {boss.requiredLevel != null && boss.rewardUntilLevel != null
                    ? `Уровень ${fmt(boss.requiredLevel)}–${fmt(boss.rewardUntilLevel)}`
                    : "Дроп босса"}
                </CardDescription>
              </div>
              <div className="business-requirements-drops">
                {(boss.dropItems || []).map((item) => (
                  <div
                    className="business-requirements-item"
                    key={item.entityId}
                  >
                    <BusinessItemTile
                      itemId={item.entityId}
                      name={item.name}
                      size={44}
                      imageSize={40}
                    />
                    <span
                      className="business-requirements-count"
                      aria-label={
                        item.requiredAmount == null
                          ? "Необходимое количество пока неизвестно"
                          : `Нужно собрать ${fmt(item.requiredAmount)} предметов`
                      }
                      title={item.name}
                    >
                      ×{" "}
                      {item.requiredAmount == null
                        ? "—"
                        : fmt(item.requiredAmount)}
                    </span>
                  </div>
                ))}
              </div>
            </BaseCard>
          ))}
        </ul>
        {!bosses.length && (
          <CardDescription>Предметы пока не указаны.</CardDescription>
        )}
        {disagreements.map((total) => (
          <p className="business-requirements-provenance" key={total.itemName}>
            «{total.itemName}»: в исходной строке «ИТОГО» — {total.declared},
            сумма по уровням — {total.computed}. Использована сумма по уровням.
          </p>
        ))}
      </div>
    </Modal>
  );
}
