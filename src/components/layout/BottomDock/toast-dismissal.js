export function pruneDismissedFeatures(dismissed, confirmed) {
  const active = new Set(confirmed);
  return dismissed.filter((feature) => active.has(feature));
}

export function newlyConfirmedFeatures(dismissed, confirmed) {
  const alreadyDismissed = new Set(dismissed);
  return confirmed.filter((feature) => !alreadyDismissed.has(feature));
}
