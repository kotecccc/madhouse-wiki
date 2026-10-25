// Damage is a value interval, never a pixel size. Ignore unavailable data,
// initial snapshots, healing, and switches to another resource or scale.
export function nextProgressLoss(previous, current, active, revision) {
  if (
    !previous ||
    !previous.enabled ||
    !current.enabled ||
    previous.max !== current.max ||
    previous.segments !== current.segments ||
    previous.key !== current.key ||
    current.value > previous.value
  )
    return null;
  if (current.value === previous.value) return active;
  return {
    from: Math.max(previous.value, active?.from ?? previous.value),
    to: current.value,
    id: revision,
  };
}

export function progressLossSegment(loss, start, max) {
  if (!loss || !(max > 0)) return null;
  const left = Math.max(start, loss.to);
  const right = Math.min(start + max, loss.from);
  return right > left
    ? {
        left: ((left - start) / max) * 100,
        width: ((right - left) / max) * 100,
      }
    : null;
}

export function finishProgressLoss(active, revision) {
  return active?.id === revision ? null : active;
}
