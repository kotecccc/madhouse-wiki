import "./ProgressBar.css";

export function ProgressBar({
  value,
  max,
  segments = 1,
  label,
  valueText,
  size = "sm",
  displayText,
  className = "",
}) {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 1;
  const safeValue = Number.isFinite(value)
    ? Math.min(safeMax, Math.max(0, value))
    : 0;
  const segmentCount =
    Number.isSafeInteger(segments) && segments > 0 ? segments : 1;
  const renderedSegments = segmentCount <= 100 ? segmentCount : 1;
  const segmentMax = safeMax / renderedSegments;
  const safeSize = size === "lg" ? "lg" : "sm";

  return (
    <div
      className={`ui-progress-bar ui-progress-bar--${safeSize} ${className}`.trim()}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={safeValue}
      aria-label={label}
      aria-valuetext={valueText}
    >
      {Array.from({ length: renderedSegments }, (_, index) => {
        const segmentStart = index * segmentMax;
        const segmentValue = Math.min(
          segmentMax,
          Math.max(0, safeValue - segmentStart),
        );
        return (
          <progress
            className="ui-progress-bar-segment"
            key={index}
            value={segmentValue}
            max={segmentMax}
            aria-hidden="true"
          />
        );
      })}
      {safeSize === "lg" && displayText != null && (
        <span className="ui-progress-bar-label" aria-hidden="true">
          <span>{displayText}</span>
        </span>
      )}
    </div>
  );
}
