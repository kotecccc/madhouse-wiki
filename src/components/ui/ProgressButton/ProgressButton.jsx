import { progressPercent } from "../../../lib/progress-percent.js";
import { Icon } from "../Icon/Icon.jsx";
import { ImageCard } from "../ImageCard/ImageCard.jsx";
import { BaseCard } from "../BaseCard/BaseCard.jsx";
import "./ProgressButton.css";

export function ProgressButton({
  value,
  max,
  label,
  valueText,
  icon,
  imageSrc,
  onClick,
  animateLoss = false,
  animationKey,
  displayText,
}) {
  const known = Number.isFinite(max) && max > 0 && Number.isFinite(value);
  const current = known ? Math.min(max, Math.max(0, value)) : 0;
  const percent = progressPercent(value, max);
  return (
    <div className="ui-progress-button">
      <BaseCard
        as="button"
        variant="glass-nav-circle"
        type="button"
        className="ui-progress-button-action"
        aria-label={label}
        aria-haspopup="dialog"
        title={label}
        onClick={onClick}
      >
        <svg
          className="ui-progress-button-outline"
          viewBox="0 0 100 100"
          aria-hidden="true"
        >
          <circle className="ui-progress-button-track" cx="50" cy="50" r="48" />
          {known && (
            <circle
              key={animationKey}
              className={`ui-progress-button-fill${animateLoss ? " ui-progress-button-fill--animated" : ""}`}
              cx="50"
              cy="50"
              r="48"
              pathLength="100"
              strokeDasharray={`${(current / max) * 100} 100`}
            />
          )}
        </svg>
        {imageSrc ? (
          <ImageCard src={imageSrc} size={24} imageSize={24} alt="">
            <Icon type={icon} size="large" tone="inherit" />
          </ImageCard>
        ) : (
          <Icon type={icon} size="large" tone="inherit" />
        )}
        <span aria-hidden="true">
          {displayText ?? (percent == null ? "—" : `${percent}%`)}
        </span>
      </BaseCard>
      <span
        className="sr-only"
        role="progressbar"
        aria-label={label}
        aria-valuemin={known ? 0 : undefined}
        aria-valuemax={known ? max : undefined}
        aria-valuenow={known ? current : undefined}
        aria-valuetext={
          valueText ?? (percent == null ? "Получаем прогресс" : `${percent}%`)
        }
      />
    </div>
  );
}
