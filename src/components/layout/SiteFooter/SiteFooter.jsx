import "./SiteFooter.css";
import { Brand } from "../Brand/Brand.jsx";
export function SiteFooter() {
  return (
    <footer className="footer">
      <Brand />
      <p className="footer-disclaimer">
        Фанатский справочник. Не связан с разработчиками игры.
      </p>
    </footer>
  );
}
