import { BaseCard } from "../../ui/BaseCard/BaseCard.jsx";
import { Button } from "../../ui/Button/Button.jsx";
import { Pill } from "../../ui/Pill/Pill.jsx";
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
  inventoryCount = 0,
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
              aria-label={
                id === "inventory" && inventoryCount > 0
                  ? `${label}: доступно для покупки ${inventoryCount}`
                  : label
              }
              title={label}
              aria-pressed={activeScreen === id}
              aria-controls={`screen-${id}`}
              onClick={() => onScreenChange(id)}
            >
              <span className="mobile-navigation-icon">
                <Icon type={icon} size="large" />
                {id === "inventory" && inventoryCount > 0 && (
                  <span className="mobile-navigation-count" aria-hidden="true">
                    <Pill size="2xs" dot={false}>
                      {inventoryCount}
                    </Pill>
                  </span>
                )}
              </span>
              <span className="mobile-navigation-label">{label}</span>
            </Button>
          ))}
      </nav>
    </BaseCard>
  );
}
