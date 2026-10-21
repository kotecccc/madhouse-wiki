import "./Icon.css";
export function Icon({ type, size, className = "" }) {
  const paths = {
    boss: (
      <>
        <path d="M5 21v-2a7 7 0 0 1 14 0v2M8 6l1-3h6l1 3v5a4 4 0 0 1-8 0V6Z" />
        <path d="M10 9h.01M14 9h.01M10 12h4" />
      </>
    ),
    chevron: <path d="m5 8.5 7 7 7-7" strokeWidth="1.5" />,
    "external-link": (
      <>
        <path d="M14 4h6v6M20 4l-9 9" />
        <path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
      </>
    ),
    message: (
      <>
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-5.5 4v-4.1A2.5 2.5 0 0 1 4 13.5v-8Z" />
        <path d="M8 8h8M8 11.5h5" />
      </>
    ),
    copy: (
      <>
        <rect x="8" y="8" width="12" height="13" rx="1.5" />
        <path d="M16 8V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2" />
      </>
    ),
    loot: (
      <>
        <path d="m8 3 2 5h4l2-5-4 1-4-1ZM9 8c-2 2-5 5-5 9 0 3 3 4 8 4s8-1 8-4c0-4-3-7-5-9M8 8h8" />
        <path d="M12 12v5m-2-3h4" />
      </>
    ),
    levels: (
      <>
        <path d="M4 3v17h17M8 16v-4m5 4V9m5 7V5" />
      </>
    ),
    lock: (
      <>
        <path d="M7.25 10V7.5a4.75 4.75 0 0 1 9.5 0V10" />
        <rect x="5" y="10" width="14" height="11" rx="1.8" />
        <path d="M12 14v3" />
      </>
    ),
    unlock: (
      <>
        <path d="M7.25 10V7.5a4.75 4.75 0 0 1 9.5 0" />
        <rect x="5" y="10" width="14" height="11" rx="1.8" />
        <path d="M12 14v3" />
      </>
    ),
    business: (
      <>
        <g strokeWidth="1.5">
          <path d="M8.5 9.45a3.5 1.5 0 1 0 0 2.1M15.5 9.45a3.5 1.5 0 1 1 0 2.1" />
          <path d="M2.5 10.5v9A3.5 1.5 0 0 0 9 20.273M21.5 10.5v9a3.5 1.5 0 0 1-6.5.773" />
          <path d="M2.5 13.5a3.5 1.5 0 0 0 6 1.05M21.5 13.5a3.5 1.5 0 0 1-6 1.05M2.5 16.5a3.5 1.5 0 0 0 6 1.05M21.5 16.5a3.5 1.5 0 0 1-6 1.05" />
          <ellipse cx="12" cy="4.5" rx="3.5" ry="1.5" />
          <path d="M8.5 4.5v15a3.5 1.5 0 0 0 7 0v-15" />
          <path d="M8.5 7.5a3.5 1.5 0 0 0 7 0M8.5 10.5a3.5 1.5 0 0 0 7 0M8.5 13.5a3.5 1.5 0 0 0 7 0M8.5 16.5a3.5 1.5 0 0 0 7 0" />
        </g>
      </>
    ),
    bug: (
      <>
        <path d="M12 7.5a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 1 1-5 0v-5A2.5 2.5 0 0 1 12 7.5Z" />
        <path d="M12 9.5v8M9.5 11h-4M18.5 11h-4M9.5 14h-4M18.5 14h-4M10 8.5 7 5.5M14 8.5l3-3M10 17.5 7 20.5M14 17.5l3 3M10.5 7l-1-2.5M13.5 7l1-2.5" />
      </>
    ),
    department: (
      <>
        <path d="M4 21V8l8-5 8 5v13M8 21v-6h8v6M9 10h.01M15 10h.01M9 13h.01M15 13h.01" />
      </>
    ),
    floor: (
      <>
        <g strokeWidth="1.75">
          <path d="M4 20V7l8-4 8 4v13" />
          <path d="M8.5 20v-5h7v5" />
        </g>
        <g fill="currentColor" stroke="none">
          <circle cx="8" cy="9" r="0.8" />
          <circle cx="12" cy="9" r="0.8" />
          <circle cx="16" cy="9" r="0.8" />
          <circle cx="8" cy="12" r="0.8" />
          <circle cx="12" cy="12" r="0.8" />
          <circle cx="16" cy="12" r="0.8" />
        </g>
      </>
    ),
    combat: (
      <>
        <g transform="translate(.5 .6) rotate(-35 12 12)" strokeWidth="1.7">
          <path d="M7.8 3.2h6.8a.8.8 0 0 1 .8.8v16.6a1.7 1.7 0 0 1-3.4 0v-5.1H7.8a1 1 0 0 1-1-1V4.2a1 1 0 0 1 1-1Z" />
          <path d="M12 15.5h3.4" />
          <path d="M8.9 5.9v7.7" strokeWidth="1.1" />
          <circle cx="13" cy="5.7" r=".75" fill="currentColor" stroke="none" />
          <circle
            cx="13.7"
            cy="19.8"
            r=".55"
            fill="currentColor"
            stroke="none"
          />
        </g>
      </>
    ),
    fist: (
      <>
        <path d="M7 11V6a2 2 0 0 1 4 0v4-5a2 2 0 0 1 4 0v5-3a2 2 0 0 1 4 0v6l1 2a5 5 0 0 1-5 7h-4a6 6 0 0 1-5-3l-3-4a2.2 2.2 0 0 1 3.5-2.6L8 15v-4a1.5 1.5 0 0 1 3 0" />
      </>
    ),
    fire: (
      <>
        <path d="M12 22c4.4 0 7-3 7-7 0-3.1-1.8-5.8-4.4-8-.1 2.2-.9 3.4-2 4.2C12.2 7.1 10.3 4.8 7 3c.5 3.5-.2 5-1.7 7C3.9 12 3 13.6 3 15c0 4 3.2 7 9 7Z" />
        <path d="M12 22c-2.1-1.1-3.2-2.7-3.2-4.7 0-1.6 1-3.2 2.5-4.8.4 1.5 1.1 2.3 2.3 3.1 1.1.8 1.4 1.7 1.4 2.5 0 1.7-1 3-3 3.9Z" />
      </>
    ),
    dice: (
      <>
        <g strokeWidth="1.5">
          <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
          <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
        </g>
        <g fill="currentColor" stroke="none">
          <g transform="matrix(.8 -.45 .8 .45 4 7.5)">
            <circle cx="5" cy="5" r=".95" />
          </g>
          <g transform="matrix(.8 .45 0 .9 4 7.5)">
            <circle cx="3" cy="3" r=".95" />
            <circle cx="7" cy="7" r=".95" />
          </g>
          <g transform="matrix(.8 -.45 0 .9 12 12)">
            <circle cx="7" cy="3" r=".95" />
            <circle cx="5" cy="5" r=".95" />
            <circle cx="3" cy="7" r=".95" />
          </g>
        </g>
      </>
    ),
    stash: (
      <>
        <path d="M4 8h16v12H4zM3 5h18v3H3zM9 12h6M9 15h6" />
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
    coin: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M14.5 8H11a2 2 0 0 0 0 4h2a2 2 0 0 1 0 4H9.5M12 6.5v11" />
      </>
    ),
    pill: (
      <g transform="rotate(-45 12 12)">
        <rect x="2" y="7" width="20" height="10" rx="5" />
        <path d="M12 7v10" />
      </g>
    ),
    banknote: (
      <>
        <rect x="2.5" y="5.5" width="19" height="13" rx="2" />
        <circle cx="12" cy="12" r="3.25" />
        <g fill="currentColor" stroke="none">
          <circle cx="6" cy="12" r="0.8" />
          <circle cx="18" cy="12" r="0.8" />
        </g>
      </>
    ),
  };
  return (
    <svg
      className={["ui-icon", size && `ui-icon--${size}`, className]
        .filter(Boolean)
        .join(" ")}
      viewBox="0 0 24 24"
      strokeWidth={
        ["floor", "coin", "pill", "banknote"].includes(type) ? 1.75 : undefined
      }
      aria-hidden="true"
    >
      {paths[type]}
    </svg>
  );
}
