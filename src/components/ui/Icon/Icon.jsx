import "./Icon.css";
export function Icon({ type }) {
  const paths = {
    lock: (
      <>
        <path d="M7.25 10V7.5a4.75 4.75 0 0 1 9.5 0V10" />
        <rect x="5" y="10" width="14" height="11" rx="1.8" />
        <path d="M12 14v3" />
      </>
    ),
    business: (
      <>
        <path d="M4 20V7l8-4 8 4v13M8 20v-5h8v5M8 9h.01M12 9h.01M16 9h.01M8 12h.01M12 12h.01M16 12h.01" />
      </>
    ),
    book: (
      <>
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
        <path d="M8 7h8M8 11h5" />
      </>
    ),
    calc: (
      <>
        <rect x="5" y="3" width="14" height="18" rx="2" />
        <path d="M8 7h8M8 11h2m4 0h2m-8 4h2m4 0h2m-8 4h2m4 0h2" />
      </>
    ),
  };
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
      {paths[type]}
    </svg>
  );
}
