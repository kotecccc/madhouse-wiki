import "./BusinessCard.css";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";

export function BusinessCard({ business, upgrade, onUpgradeSelect }) {
  return (
    <BaseCard variant="floor-data" as="li" className="floor-business-card">
      <ImageCard
        className="floor-business-icon"
        size="var(--business-image-size)"
        imageSize="var(--business-image-content-size)"
        label={`Бизнес: ${business.title}`}
      >
        <Icon type="business" />
      </ImageCard>
      <div className="floor-business-copy">
        <CardTitle className="floor-work-business-name">
          {business.title}
        </CardTitle>
        <CardDescription as="small" className="floor-business-income">
          Доход не указан
        </CardDescription>
      </div>
      <Button
        variant="card-action"
        icon="levels"
        title="Уровни бизнеса"
        className="business-upgrade-open"
        disabled={!upgrade}
        aria-label={`Требования по предметам для бизнеса «${business.title}»`}
        onClick={() => onUpgradeSelect({ business, upgrade })}
      >
        <span>Уровни</span>
      </Button>
    </BaseCard>
  );
}
