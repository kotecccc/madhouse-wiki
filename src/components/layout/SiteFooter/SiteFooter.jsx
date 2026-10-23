import "./SiteFooter.css";
export function SiteFooter({ children }) {
  return (
    <footer className="footer">
      <p className="footer-disclaimer">
        Фанатский справочник. Не связан с разработчиками игры.
      </p>
      {children}
    </footer>
  );
}
