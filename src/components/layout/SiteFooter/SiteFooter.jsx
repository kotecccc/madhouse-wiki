import "./SiteFooter.css";
import { Brand } from "../Brand/Brand.jsx";
export function SiteFooter({ onPrivacySettings }) {
  return (
    <footer className="footer">
      <Brand />
      <p className="footer-disclaimer">
        Фанатский справочник. Не связан с разработчиками игры.
      </p>
      <button
        className="footer-privacy-link"
        type="button"
        onClick={onPrivacySettings}
      >
        Приватность
      </button>
    </footer>
  );
}
