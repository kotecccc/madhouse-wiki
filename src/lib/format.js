const numberFormatter = new Intl.NumberFormat("ru-RU");
const energyFormatter = new Intl.NumberFormat("ru-RU", {
  maximumFractionDigits: 2,
});
export const fmt = (value) => numberFormatter.format(value);
export const fmtEnergy = (value) => energyFormatter.format(value);
export function restoreTime(minutes) {
  const d = Math.floor(minutes / 1440),
    h = Math.floor((minutes % 1440) / 60),
    m = minutes % 60;
  return [
    d ? `${d} дн` : "",
    h ? `${h} ч` : "",
    m || (!d && !h) ? `${m} мин` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
