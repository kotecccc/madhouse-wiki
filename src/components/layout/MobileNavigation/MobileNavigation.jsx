import { BaseCard } from "../../ui/BaseCard/BaseCard.jsx";
import { Button } from "../../ui/Button/Button.jsx";
import { Icon } from "../../ui/Icon/Icon.jsx";
import "./MobileNavigation.css";

const screens = [
  { id: "raids", label: "Рейды", icon: "boss" },
  { id: "overview", label: "Главная", icon: "character" },
  { id: "inventory", label: "Инвентарь", icon: "loot" },
];

export function MobileNavigation({
  activeScreen,
  onScreenChange,
  authenticated = false,
  desktop = false,
}) {
  return (
    <BaseCard
      variant="glass-nav"
      className={desktop ? "desktop-navigation" : "mobile-navigation"}
    >
      <nav className="mobile-navigation-items" aria-label="Разделы Wiki">
        {screens
          .filter((screen) => screen.id !== "inventory" || authenticated)
          .map(({ id, label, icon }) => (
            <Button
              key={id}
              variant="nav-tab"
              aria-label={label}
              title={label}
              aria-pressed={activeScreen === id}
              aria-controls={`screen-${id}`}
              onClick={() => onScreenChange(id)}
            >
              <Icon type={icon} size="large" />
              <span className="mobile-navigation-label">{label}</span>
            </Button>
          ))}
      </nav>
    </BaseCard>
  );
}
