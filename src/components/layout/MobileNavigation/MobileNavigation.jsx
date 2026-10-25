import { BaseCard } from "../../ui/BaseCard/BaseCard.jsx";
import { Button } from "../../ui/Button/Button.jsx";
import { Icon } from "../../ui/Icon/Icon.jsx";
import "./MobileNavigation.css";

const screens = [
  { id: "floors", label: "Этажи", icon: "floor" },
  { id: "overview", label: "Главная", icon: "character" },
  { id: "raids", label: "Рейды", icon: "combat" },
];

export function MobileNavigation({
  activeScreen,
  onScreenChange,
  isAuthenticated,
}) {
  const visibleScreens = isAuthenticated
    ? screens
    : screens.filter((screen) => screen.id !== "overview");
  return (
    <BaseCard variant="glass-nav" className="mobile-navigation">
      <nav className="mobile-navigation-items" aria-label="Разделы Wiki">
        {visibleScreens.map(({ id, label, icon }) => (
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
