import { BaseCard } from "../../ui/BaseCard/BaseCard.jsx";
import { Button } from "../../ui/Button/Button.jsx";
import { Icon } from "../../ui/Icon/Icon.jsx";
import "./MobileNavigation.css";

const screens = [
  { id: "floors", label: "Этажи", icon: "floor" },
  { id: "raids", label: "Рейды", icon: "combat" },
];

export function MobileNavigation({ activeScreen, onScreenChange }) {
  return (
    <BaseCard
      as="nav"
      variant="glass-nav"
      className="mobile-navigation"
      aria-label="Разделы Wiki"
    >
      {screens.map(({ id, label, icon }) => (
        <Button
          key={id}
          variant="nav-tab"
          aria-pressed={activeScreen === id}
          aria-controls={`screen-${id}`}
          onClick={() => onScreenChange(id)}
        >
          <Icon type={icon} size="medium" />
          <span>{label}</span>
        </Button>
      ))}
    </BaseCard>
  );
}
