import { BossCardView } from "./BossCardView.jsx";
export function BossCard({ boss }) {
  return <BossCardView boss={boss} as="article" className="boss-card" />;
}
