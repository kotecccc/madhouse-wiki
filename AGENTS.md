# Madhouse Wiki UI rules

## Design tokens

Use the shared tokens in `src/styles/tokens.css` and `src/components/ui/BaseCard.css` for every independent card:

- `--card-background` for the surface
- `--card-border` for its border
- `--card-radius` for its corner radius
- `--card-padding` for its internal padding
- `--card-content-gap` for spacing between content roles
- `--card-line-height` for title and description line height
- `--card-title-color` and `--card-title-size` for titles
- `--card-description-color` and `--card-description-size` for supporting descriptions

`BaseCard` in `src/components/ui/BaseCard.jsx` is the reusable React surface. Use its `.base-card` class for each independent card. Put visual variants in the shared token/variant rules in `src/styles/tokens.css` and `src/components/ui/BaseCard.css`; do not add one-off borders, radii, backgrounds, or padding to individual card selectors.

The large outside shells of expandable work blocks (`.floor-work-disclosure`) are intentionally exempt. Their internal independent requirement, business, upgrade, and boss cards use the shared card surface. Floor group containers are layout columns, not cards.

## Component styles

Keep styles beside the component that owns them: `Component.jsx` imports its own `Component.css`. Keep responsive rules, states, and variants with that component. Do not create aggregate component stylesheets such as `base.css`, `sections.css`, or `cards.css`, or a central stylesheet that imports every component.

Only `src/styles/tokens.css` (design tokens) and `src/styles/global.css` (reset, document background, base typography, accessibility utilities, and reduced motion) are global entrypoint imports. Shared visual behavior belongs to reusable UI components and their colocated styles, including `BaseCard.css`, `CardText.css`, `Button.css`, `FieldLabel.css`, and `Dialog.css`. Composition-only wrappers reuse their child component's styling instead of creating empty stylesheets.

Parent components own layout; child components own their appearance. Pass variants or custom properties through the shared UI API instead of styling child internals from a parent stylesheet. Floor content cards use the shared `floor-data` BaseCard variant to preserve their existing spacing without ancestor list overrides.

## Content roles and behavior

Card titles use `.card-title`; supporting copy uses `.card-description`. Both roles share the A2 summary title and description color, font family, weight, letter spacing, word spacing, line height, and one-line ellipsis behavior. The only permitted typography difference between card types is `font-size`, controlled by the inherited `--card-title-size` and `--card-description-size` tokens. Remove old selector-specific typography when adding these roles; do not layer new overrides over obsolete styles. Long block titles remain on one line and end with an ellipsis.

Use `local-data/madhouse.sqlite` as the canonical catalogue. `scripts/catalogue/schema.sql` defines the SQL schema; `scripts/catalogue/query.mjs` reads entities and relationships for the React model through the Vite virtual module. Populate definitions only from authorized API responses using strict reference-field allowlists. Public client routing may discover API identifiers and department membership, with separate provenance; it must not seed entity definitions. Do not recreate legacy JSON catalogues, snapshots, or browser globals. Keep Swagger/OpenAPI JSON contracts as API documentation.

Preserve source wording and uncertainty notes. Keep all three requirement types: business level, work completions, and boss kills. Requirement targets should use entity IDs. Do not display or store account-specific current counts, completion flags, progress, access, or business lock states.

Keep all floor opening-condition wording intact, including notes that conditions are incomplete or unverified.

## React and build

The entire application renders through React and the production build uses Vite. Do not add imperative DOM rendering, injected HTML templates, or parallel legacy behavior. Reusable UI belongs in React components, while styling variants belong in the shared design system. Use `BaseCard` for independent cards and shared components for repeated visual elements; do not solve card cases with local CSS overrides.
