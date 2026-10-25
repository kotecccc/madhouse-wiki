import { BorderLoader } from "../../ui/BorderLoader/BorderLoader.jsx";
import { LoginControl } from "../../../features/auth/LoginControl/LoginControl.jsx";
import "./SiteHeader.css";
import { Brand } from "../Brand/Brand.jsx";

export function SiteHeader({ loading = false, showDivider = true }) {
  return (
    <header
      className={`topbar${loading ? " topbar--loading" : ""}${showDivider ? "" : " topbar--without-divider"}`}
    >
      <Brand />
      <LoginControl />
      {loading && showDivider && (
        <span className="topbar-loader">
          <BorderLoader />
        </span>
      )}
    </header>
  );
}
