import "./BossCard.css";
import { BusinessItemTile } from "../../businesses/BusinessItemTile/BusinessItemTile.jsx";
import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { knowledgeBase as kb } from "../../../../data/index.js";
import { fmt } from "../../../lib/format.js";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
export function BossCard({ boss, old }) {
  const oldData = kb.assets.legacyBosses[`boss-${boss.numericId}`];
  const img =
    old && oldData
      ? new URL(oldData.image, kb.assets.legacyBossImageBase).href
      : boss.image;
  return (
    <BaseCard as="article" className="boss-card">
      <ImageCard src={img} alt="" />
      <div className="boss-details">
        <CardTitle as="h4">
          {old && oldData ? oldData.name : boss.name}
        </CardTitle>
        <CardDescription as="p" className="boss-stats">
          Уровень {fmt(boss.requiredLevel)} · {fmt(boss.maxHp)} HP
        </CardDescription>
      </div>
      <BusinessItemTile itemId={boss.dropItemId} size={72} />
    </BaseCard>
  );
}
