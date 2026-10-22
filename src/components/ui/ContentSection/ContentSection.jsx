import "./ContentSection.css";

export function ContentSection({ className = "", ...props }) {
  return (
    <section className={`content-section ${className}`.trim()} {...props} />
  );
}
