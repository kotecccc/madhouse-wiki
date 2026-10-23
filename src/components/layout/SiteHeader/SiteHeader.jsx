import { LoginControl } from "../../../features/auth/LoginControl/LoginControl.jsx";
import "./SiteHeader.css";
import { Brand } from "../Brand/Brand.jsx";

export function SiteHeader({ loading = false }) {
  return (
    <header className={`topbar${loading ? " topbar--loading" : ""}`}>
      <Brand />
      <LoginControl />
    </header>
  );
}
