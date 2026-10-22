import { BossCardVariant } from "../BossCard/BossCardVariant.jsx";
import { CardEditScope } from "../../../components/ui/CardEditing/CardEditing.jsx";

export function DepartmentBossCard({ boss }) {
  return (
    <CardEditScope scope={`boss:${boss.id}`}>
      <BossCardVariant
        preset="boss-main"
        boss={boss}
        as="li"
        variant="floor-data"
        className="floor-block-boss-card"
      />
    </CardEditScope>
  );
}
