import "./Brand.css";
export function Brand() {
  return (
    <a className="brand" href="#top" aria-label="Madhouse Wiki — на главную">
      <img
        className="brand-mark"
        src="/madhouse-wiki-bot-avatar.png"
        alt=""
        aria-hidden="true"
      />
      <span className="brand-name">
        MADHOUSE <b>WIKI</b>
      </span>
    </a>
  );
}
