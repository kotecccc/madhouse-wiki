import "./SiteFooter.css";
import { Brand } from "../Brand/Brand.jsx";
export function SiteFooter() {
  return (
    <footer className="footer">
      <Brand />
      <p>Фанатский справочник. Не связан с разработчиками игры.</p>
      <span className="footer-version">ПЕРВАЯ ВЕРСИЯ · В РАЗРАБОТКЕ</span>
    </footer>
  );
}
