import { useLayoutEffect, useRef, useState } from "react";
import {
  nextProgressLoss,
  progressLossSegment,
  finishProgressLoss,
} from "./progress-loss.js";
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
  animateLoss = false,
  animationKey = null,
  highlightAmount = 0,
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

  const [loss, setLoss] = useState(null);
  const previous = useRef(null);
  const revision = useRef(0);
  const motion = useRef(null);
  useLayoutEffect(() => {
    if (!animateLoss || typeof window === "undefined" || !window.matchMedia)
      return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    motion.current = query;
    const changed = () => {
      if (query.matches) setLoss(null);
    };
    changed();
    if (query.addEventListener) query.addEventListener("change", changed);
    else query.addListener?.(changed);
    return () => {
      if (query.removeEventListener)
        query.removeEventListener("change", changed);
      else query.removeListener?.(changed);
      motion.current = null;
    };
  }, [animateLoss]);
  useLayoutEffect(() => {
    const current = {
      value: safeValue,
      max: safeMax,
      segments: renderedSegments,
      key: animationKey,
      enabled:
        animateLoss &&
        !motion.current?.matches &&
        Number.isFinite(value) &&
        Number.isFinite(max) &&
        max > 0,
    };
    const before = previous.current;
    previous.current = current;
    const id = ++revision.current;
    setLoss((active) => nextProgressLoss(before, current, active, id));
  }, [
    safeValue,
    safeMax,
    renderedSegments,
    animationKey,
    animateLoss,
    value,
    max,
  ]);

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
        const progress = (
          <progress
            className="ui-progress-bar-segment"
            value={segmentValue}
            max={segmentMax}
            aria-hidden="true"
          />
        );
        // Anchor the remaining personal target to the current fill's right
        // edge, clipping it only when the boss has less health left.
        const highlightStart = Math.max(
          0,
          safeValue - Math.max(0, highlightAmount),
        );
        const highlightLeft = Math.max(segmentStart, highlightStart);
        const highlightWidth = Math.max(
          0,
          Math.min(safeValue, segmentStart + segmentMax) - highlightLeft,
        );
        const highlighted =
          Number.isFinite(highlightAmount) &&
          highlightAmount > 0 &&
          highlightWidth > 0;
        if (!animateLoss && !highlighted)
          return (
            <progress
              className="ui-progress-bar-segment"
              key={index}
              value={segmentValue}
              max={segmentMax}
              aria-hidden="true"
            />
          );
        const damaged = progressLossSegment(loss, segmentStart, segmentMax);
        return (
          <span className="ui-progress-bar-segment-shell" key={index}>
            {damaged && (
              <span
                key={loss.id}
                className="ui-progress-bar-loss"
                aria-hidden="true"
                style={{
                  "--progress-loss-from": `${damaged.left + damaged.width}%`,
                  "--progress-loss-to": `${damaged.left}%`,
                }}
                onAnimationEnd={() =>
                  setLoss((active) => finishProgressLoss(active, loss.id))
                }
              />
            )}
            {progress}
            {highlighted && (
              <span
                className="ui-progress-bar-highlight"
                aria-hidden="true"
                style={{
                  left: `${((highlightLeft - segmentStart) / segmentMax) * 100}%`,
                  width: `${(highlightWidth / segmentMax) * 100}%`,
                }}
              />
            )}
          </span>
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
