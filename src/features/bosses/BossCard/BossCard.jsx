import { BossCardView } from "./BossCardView.jsx";
export function BossCard({ boss }) {
  return (
    <BossCardView
      boss={boss}
      showBattleAction
      as="article"
      className="boss-card"
    />
  );
}
