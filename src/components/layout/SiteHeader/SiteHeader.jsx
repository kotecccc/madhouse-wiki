import "./SiteHeader.css";
import { useState } from "react";
import { Button } from "../../ui/Button/Button.jsx";
import { Brand } from "../Brand/Brand.jsx";
export function SiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const onMenuToggle = () => setMenuOpen((value) => !value);
  const onNavigate = () => setMenuOpen(false);
  return (
    <header className="topbar">
      <Brand />
      <Button
        className="menu-toggle"
        type="button"
        aria-expanded={menuOpen}
        aria-controls="main-nav"
        onClick={onMenuToggle}
      >
        <span />
        <span />
        <span className="sr-only">Открыть меню</span>
      </Button>
      <nav
        className={`main-nav${menuOpen ? " is-open" : ""}`}
        id="main-nav"
        aria-label="Основная навигация"
        onClick={onNavigate}
      >
        <a href="#floors">Этажи</a>
        <a href="#bosses">Боссы</a>
        <a href="#calculator">Калькулятор</a>
      </nav>
      <div className="status-pill">
        <i /> В разработке
      </div>
    </header>
  );
}
