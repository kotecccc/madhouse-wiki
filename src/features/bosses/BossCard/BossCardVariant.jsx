import { useSyncExternalStore } from "react";
import { BossCardView } from "./BossCardView.jsx";
import { getBossCardVariantProps } from "./boss-card-variants.js";

const mobileQuery = "(max-width: 650px)";
function subscribe(onChange) {
  const query = window.matchMedia(mobileQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
const getMobile = () => window.matchMedia(mobileQuery).matches;
const getServerMobile = () => false;

export function BossCardVariant({ preset, availabilityLocked, ...props }) {
  const mobile = useSyncExternalStore(subscribe, getMobile, getServerMobile);
  const settings = getBossCardVariantProps(preset, mobile);
  const showAvailability =
    settings?.showAvailability && (availabilityLocked ?? true);
  return (
    <BossCardView
      {...settings}
      {...props}
      showAvailability={showAvailability}
    />
  );
}
