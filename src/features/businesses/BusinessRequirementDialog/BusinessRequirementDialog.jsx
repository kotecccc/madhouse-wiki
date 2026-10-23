import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";
import { Modal } from "../../../components/ui/Modal/Modal.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { BossCardVariant } from "../../bosses/BossCard/BossCardVariant.jsx";
import { bossDisplayFields } from "../../../lib/card-display-fields.js";
import { BusinessItemDropList } from "../BusinessItemDropList/BusinessItemDropList.jsx";
import {
  bossById,
  departmentById,
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

function BusinessRequirementSource({ boss, imageLoading }) {
  const department = departmentById[boss.departmentId];
  const items = boss.dropItems || [];

  if (boss.kind === "boss")
    return (
      <BossCardVariant
        as="li"
        boss={boss}
        preset="boss-business"
        variant="floor-data"
        displayFields={bossDisplayFields(boss, department || {})}
        showDropList={false}
        imageLoading={imageLoading}
        action={
          <BusinessItemDropList
            items={items}
            bossName={boss.name}
            loading={imageLoading}
          />
        }
      />
    );

  return (
    <BaseCard
      as="li"
      variant="floor-data"
      className="business-requirements-source"
    >
      <ImageCard
        src={boss.image}
        alt={boss.name}
        size={58}
        imageSize="100%"
        loading={imageLoading}
      />
      <div className="business-requirements-copy">
        <CardTitle>{boss.name}</CardTitle>
        <CardDescription>Дроп босса</CardDescription>
      </div>
      <div className="business-requirements-drops">
        {items.map((item) => (
          <div className="business-requirements-item" key={item.entityId}>
            <CardDescription as="span" size="xs">
              × {item.requiredAmount == null ? "—" : fmt(item.requiredAmount)}
            </CardDescription>
            <BusinessItemTile
              itemId={item.entityId}
              name={item.name}
              size={44}
              imageSize={40}
              loading={imageLoading}
            />
          </div>
        ))}
      </div>
    </BaseCard>
  );
}

export function BusinessRequirementContent({
  business,
  requirement,
  imageLoading,
}) {
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
    <div className="business-requirements-content">
      <ul className="business-requirements-sources">
        {bosses.map((boss) => (
          <BusinessRequirementSource
            key={boss.id}
            boss={boss}
            imageLoading={imageLoading}
          />
        ))}
      </ul>
      {!bosses.length && (
        <CardDescription>Предметы пока не указаны.</CardDescription>
      )}
      {disagreements.map((total) => (
        <CardDescription as="p" key={total.itemName}>
          «{total.itemName}»: в исходной строке «ИТОГО» — {total.declared},
          сумма по уровням — {total.computed}. Использована сумма по уровням.
        </CardDescription>
      ))}
    </div>
  );
}

export function BusinessRequirementDialog({ business, requirement, onClose }) {
  const level = requirement?.requiredLevel ?? requirement?.required;
  return (
    <Modal
      title={`Что собирать для «${business?.title || "Бизнес"}»${level != null ? `, уровень ${fmt(level)}` : ""}?`}
      titleId="business-requirements-title"
      width={560}
      onClose={onClose}
      contentVariant="inset"
      footer={<Button onClick={onClose}>Закрыть</Button>}
    >
      <BusinessRequirementContent
        business={business}
        requirement={requirement}
      />
    </Modal>
  );
}
