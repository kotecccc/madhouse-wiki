import { useState } from "react";
import "./UpgradeDialog.css";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { Modal } from "../../../components/ui/Modal/Modal.jsx";
import { NumberStepper } from "../../../components/ui/NumberStepper/NumberStepper.jsx";
import { BossCardView } from "../../bosses/BossCard/BossCardView.jsx";
import { bossById } from "../../../model/knowledge-base.js";
import { fmt } from "../../../lib/format.js";
import {
  getBusinessUpgradeTotals,
  findItemBosses,
} from "../../../lib/business-upgrades.js";

export function UpgradeDialog({ data, onClose }) {
  const { business, upgrade } = data;
  const items = upgrade?.items || [];
  const levelCount = Math.max(
    0,
    ...items.map((item) => item.levels?.length || 0),
  );
  const [selection, setSelection] = useState({
    businessId: business.id,
    level: levelCount,
  });
  const targetLevel =
    selection.businessId === business.id
      ? Math.min(levelCount, Math.max(1, selection.level))
      : levelCount;
  const totals = getBusinessUpgradeTotals(upgrade, targetLevel);
  const bossNeeds = new Map();
  const unmatchedItems = [];

  for (const item of totals) {
    const matches = findItemBosses(Object.values(bossById), item.entityId);
    if (!matches.length) unmatchedItems.push(item);
    for (const boss of matches) {
      const group = bossNeeds.get(boss.id) ?? { ...boss, dropItems: [] };
      group.dropItems.push(item);
      bossNeeds.set(boss.id, group);
    }
  }

  return (
    <Modal
      className="business-upgrade-dialog"
      title={business.title || "Бизнес"}
      titleId="upgrade-title"
      onClose={onClose}
      width={680}
    >
      {!upgrade || levelCount === 0 ? (
        <p className="business-upgrade-empty">
          Данные об улучшениях отсутствуют.
        </p>
      ) : (
        <div className="business-upgrade-content">
          <div className="business-upgrade-controls">
            <div className="business-upgrade-controls-copy">
              <h3 className="business-upgrade-section-title">
                До уровня {targetLevel}
              </h3>
              <p className="business-upgrade-summary-note">
                Всего предметов для улучшения с первого уровня.
              </p>
            </div>
            <NumberStepper
              id="business-upgrade-target-level"
              label="Целевой уровень"
              min={1}
              max={levelCount}
              value={targetLevel}
              onChange={(level) =>
                setSelection({ businessId: business.id, level })
              }
            />
          </div>
          <ul
            className="business-upgrade-boss-list"
            aria-label={`Боссы и предметы до уровня ${targetLevel}`}
          >
            {[...bossNeeds.values()].map((boss) => (
              <BossCardView
                boss={boss}
                as="li"
                variant="floor-data"
                key={boss.id}
              />
            ))}
          </ul>
          {unmatchedItems.map((item, index) => (
            <CardDescription key={`${item.entityId ?? item.name}-${index}`}>
              {item.name || "Предмет не указан"}:{" "}
              {item.requiredAmount == null ? "—" : fmt(item.requiredAmount)}.
              Босс пока не указан.
            </CardDescription>
          ))}
          {(upgrade.sourceTotals ?? [])
            .filter(
              (total) =>
                !total.matches &&
                (total.lastLevel == null || total.lastLevel <= targetLevel),
            )
            .map((total) => (
              <p className="business-upgrade-empty" key={total.itemName}>
                «{total.itemName}»: исходный итог {total.declared}, сумма по
                уровням {total.computed}.
              </p>
            ))}
          <details className="business-upgrade-breakdown">
            <summary>Требования по уровням</summary>
            <div className="business-upgrade-table-wrap">
              <table className="business-upgrade-table">
                <thead>
                  <tr>
                    <th scope="col">Предмет</th>
                    {Array.from({ length: levelCount }, (_, index) => (
                      <th
                        scope="col"
                        key={index}
                        data-selected={index + 1 === targetLevel || undefined}
                      >
                        Уровень {index + 1}
                      </th>
                    ))}
                    <th scope="col">До уровня {targetLevel}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, index) => {
                    const total = totals[index]?.requiredAmount;
                    return (
                      <tr key={`${item.entityId ?? item.name}-${index}`}>
                        <th scope="row">{item.name || "Предмет не указан"}</th>
                        {Array.from({ length: levelCount }, (_, levelIndex) => (
                          <td
                            key={levelIndex}
                            data-selected={
                              levelIndex + 1 === targetLevel || undefined
                            }
                          >
                            {item.levels?.[levelIndex] == null
                              ? "—"
                              : fmt(item.levels[levelIndex])}
                          </td>
                        ))}
                        <td>{total == null ? "—" : fmt(total)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      )}
    </Modal>
  );
}
