import "./Divider.css";

export function Divider({ fullWidth = false }) {
  return (
    <hr className={`ui-divider${fullWidth ? " ui-divider--full-width" : ""}`} />
  );
}
