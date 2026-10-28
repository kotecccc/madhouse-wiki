import "./Divider.css";

export function Divider({ fullWidth = false, menu = false }) {
  return (
    <hr
      className={`ui-divider${fullWidth ? " ui-divider--full-width" : ""}${menu ? " ui-divider--menu" : ""}`}
    />
  );
}
