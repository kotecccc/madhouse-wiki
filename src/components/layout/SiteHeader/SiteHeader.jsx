import { LoginControl } from "../../../features/auth/LoginControl/LoginControl.jsx";
import "./SiteHeader.css";
import { Brand } from "../Brand/Brand.jsx";

export function SiteHeader() {
  return (
    <header className="topbar">
      <Brand />
      <LoginControl />
    </header>
  );
}
