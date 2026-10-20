import { BossCardView } from "../BossCard/BossCardView.jsx";

export function DepartmentBossCard({ boss }) {
  return (
    <BossCardView
      boss={boss}
      as="li"
      variant="floor-data"
      className="floor-block-boss-card"
    />
  );
}
