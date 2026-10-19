import "./BusinessCard.css";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";

export function BusinessCard({ business, upgrade, onUpgradeSelect }) {
  return (
    <BaseCard variant="floor-data" as="li" className="floor-business-card">
      <CardTitle className="floor-work-business-name">
        {business.title}
      </CardTitle>
      <CardDescription as="small" className="floor-business-income">
        Доход не указан
      </CardDescription>
      <Button
        variant="secondary"
        className="business-upgrade-open"
        disabled={!upgrade}
        aria-label={`Требования по предметам для бизнеса «${business.title}»`}
        onClick={() => onUpgradeSelect({ business, upgrade })}
      >
        <Icon type="book" />
        <span>Уровни</span>
      </Button>
    </BaseCard>
  );
}
