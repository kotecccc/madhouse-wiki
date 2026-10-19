import "./DepartmentBossCard.css";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { BusinessItemTile } from "../../businesses/BusinessItemTile/BusinessItemTile.jsx";

export function DepartmentBossCard({ boss }) {
  return (
    <BaseCard variant="floor-data" as="li" className="floor-block-boss-card">
      <ImageCard src={boss.image} />
      <div>
        <CardTitle>{boss.name}</CardTitle>
        <CardDescription className="floor-work-boss-drop-name">
          Предмет бизнеса №{boss.numericId}
        </CardDescription>
      </div>
      <BusinessItemTile itemId={boss.dropItemId} />
    </BaseCard>
  );
}
