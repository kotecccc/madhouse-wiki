## Efficient edits and validation

- Keep trivial and small, well-localized edits in the main agent. Do not launch a subagent merely to find a file, inspect a few related files, change a style, or repeat the main agent's investigation.
- Delegate only a bounded, independently useful task when the expected benefit exceeds startup, context transfer and review costs. Use GPT-6 Luna with medium reasoning and a short standalone brief (`fork_turns: none`) for routine delegated work. Keep integration and consequential decisions in the main agent.
- Match validation to the change. Run `npm run lint:ui`, lint/format checks for changed files, relevant tests and the relevant build. Batch checks after a coherent edit; do not repeat successful checks unless subsequent changes or new evidence affect them.
- Reserve `npm run check` (whole-project data, lint, formatting, tests and build) for releases, broad changes or a concrete cross-cutting risk. Do not run it automatically for every minor follow-up. If it has passed, do not rerun its constituent checks without a reason.
- When another chat is working in the same checkout, inspect current changes and avoid overlapping edits and duplicate heavyweight checks. Do not attribute unrelated failures to the current edit without evidence.
- Never generate Telegram cards locally, including during builds and checks. Vite builds do not include card generation. Only the production VPS wiki service may generate them at startup, enabled by `MADHOUSE_VPS_INLINE_CARDS=1` in VPS Compose. Its disposable cache persists in the separate `telegram_cards` volume at `/data/telegram-cards`, expires after 24 hours, and invalidates on catalogue, rendering dependencies, tokens, lockfile or runtime changes. `MADHOUSE_INLINE_CARDS_REFRESH=1` forces regeneration on the next VPS service startup; never use it to generate locally. Test caching and startup gates with fake generators; do not open a browser for verification without explicit authorization.

# Madhouse Wiki UI rules

## Visual testing requires an explicit request

- Do not perform any visual testing or visual verification unless the user explicitly requests it. A request to change the UI, a supplied screenshot, or a browser comment does not authorize visual testing.
- Without that explicit request, do not open or control a browser for verification, take or inspect verification screenshots, run visual regression tests, or inspect rendered layout, geometry, computed styles, or responsive states through browser tools or automation.
- This restriction applies to the main agent and all subagents. Do not delegate visual testing or substitute another tool to bypass it.
- Source inspection and nonvisual checks such as linting, type checking, unit tests, and builds remain allowed. Requirements to run checks do not authorize visual testing.

## Mandatory UI Kit only policy

This rule applies to the entire project, including the Wiki, `/ui`, Telegram connector, responsive states, and future changes. It takes precedence over older styling exceptions below.

- Custom component appearance is strictly forbidden. All typography, colors, surfaces, borders, radii, shadows, spacing, and control/media sizes must use the existing UI Kit components, supported variants, and design tokens.
- Never use arbitrary values such as `15px`, `11px`, `0.9375rem`, literal colors, or ad hoc `calc()` expressions to tune a particular component. This includes CSS, inline React styles, style props, media queries, and JavaScript that computes appearance.
- Never create a token or a shared variant merely to disguise a one-off component override. If the existing kit cannot express a requested appearance, use the nearest supported kit choice and explain the limitation. A design-system extension requires an explicit user request.
- Feature and page styles may only compose layout using existing spacing tokens and structural CSS (grid/flex placement, responsive columns, overflow and positioning). They must not redefine the appearance of a shared child component, including through descendant selectors, CSS custom properties, or `!important`.
- Visual definitions belong to reusable UI Kit components and `src/styles/tokens.css`. Feature-specific skins and exceptions are forbidden, including the former floor disclosure exception.
- Use only the existing font-size scale. Never shrink images or compute font/icon sizes to force a text block into a fixed height; adjust layout and select supported UI Kit sizes instead.
- Preserve accessibility and intrinsic image geometry. Zero/reset values, percentages, intrinsic sizing, breakpoints, and structural layout bounds are not permission to add visual overrides.
- Before completion run `npm run lint:ui` and the relevant build/lint checks. Fix violations instead of adding exclusions or weakening the check.

## Design tokens

Use the shared tokens in `src/styles/tokens.css` and `src/components/ui/BaseCard/BaseCard.css` for every independent card:

- `--card-background` for the surface
- `--card-border` for its border
- `--card-radius` for its corner radius
- `--card-padding` for its internal padding
- `--card-content-gap` for spacing between content roles
- `--card-line-height` for title and description line height
- `--card-title-color` and `--card-title-size` for titles
- `--card-description-color` and `--card-description-size` for supporting descriptions

`BaseCard` in `src/components/ui/BaseCard/BaseCard.jsx` is the reusable React surface. Use its `.base-card` class for each independent card. Put visual variants in the shared token/variant rules in `src/styles/tokens.css` and `src/components/ui/BaseCard/BaseCard.css`; do not add one-off borders, radii, backgrounds, or padding to individual card selectors.

The outside shells of expandable work blocks (`.floor-work-disclosure`) follow the same UI Kit policy. Their internal independent requirement, business, upgrade, and boss cards use the shared card surface. Floor group containers are layout columns, not cards.

## Component styles

Keep styles beside the component that owns them: `Component.jsx` imports its own `Component.css`. Keep responsive rules, states, and variants with that component. Do not create aggregate component stylesheets such as `base.css`, `sections.css`, or `cards.css`, or a central stylesheet that imports every component.

Only `src/styles/tokens.css` (design tokens) and `src/styles/global.css` (reset, document background, base typography, accessibility utilities, and reduced motion) are global entrypoint imports. Shared visual behavior belongs to reusable UI components and their colocated styles, including `BaseCard.css`, `CardText.css`, `Button.css`, `FieldLabel.css`, and `Dialog.css`. Composition-only wrappers reuse their child component's styling instead of creating empty stylesheets.

Parent components own layout; child components own their appearance. Use only existing supported variants through the shared UI API; arbitrary custom property overrides and styling child internals are forbidden. Floor content cards use the shared `floor-data` BaseCard variant to preserve their existing spacing without ancestor list overrides.

## Content roles and behavior

Card titles use `.card-title`; supporting copy uses `.card-description`. Both roles share the A2 summary title and description color, font family, weight, letter spacing, word spacing, line height, and one-line ellipsis behavior. The only permitted typography difference between card types is `font-size`, controlled by the inherited `--card-title-size` and `--card-description-size` tokens. Remove old selector-specific typography when adding these roles; do not layer new overrides over obsolete styles. Long block titles remain on one line and end with an ellipsis.

Use `local-data/madhouse.sqlite` as the canonical catalogue. `scripts/catalogue/schema.sql` defines the SQL schema; `scripts/catalogue/query.mjs` reads entities and relationships for the React model through the Vite virtual module. Populate definitions only from authorized API responses using strict reference-field allowlists. Public client routing may discover API identifiers and department membership, with separate provenance; it must not seed entity definitions. Do not recreate legacy JSON catalogues, snapshots, or browser globals. Keep Swagger/OpenAPI JSON contracts as API documentation.

Preserve source wording and uncertainty notes. Keep all three requirement types: business level, work completions, and boss kills. Requirement targets should use entity IDs. Do not display or store account-specific current counts, completion flags, progress, access, or business lock states.

Keep all floor opening-condition wording intact, including notes that conditions are incomplete or unverified.

## React and build

The entire application renders through React and the production build uses Vite. Do not add imperative DOM rendering, injected HTML templates, or parallel legacy behavior. Reusable UI belongs in React components, while styling variants belong in the shared design system. Use `BaseCard` for independent cards and shared components for repeated visual elements; do not solve card cases with local CSS overrides.

## Server-owned automation state

- Store active battle references and confirmed state, goals and counters, automation settings, favorite selections, command receipts and execution checkpoints on the server, scoped to a verified game account. The browser is a view and command sender; it must not be the durable source of this information.
- Execute background automation on the server so closing, reloading or disconnecting a browser does not stop it. Keep only presentation state such as an open modal on the client. Do not add localStorage, IndexedDB or client timers as an automation persistence/execution fallback.
- Keep personal automation data separate from the public reference catalogue. Encrypt saved game credentials, never return them through state APIs, serialize game actions and durably record pending operations before submitting them. An uncertain operation must not be replayed automatically after restart.
- Use the shared server state/command API for new automations and settings. Tests must use fake game responses; live game traffic requires the explicit runtime gate and user authorization for verification.

## Release changelog and version

- Before every production release or deployment, add a concise summary of the changes to `changelog.json`, newest release first, and increment the application version in both `package.json` and `package-lock.json` to match the changelog entry. The header logo opens this changelog in the application.
- Versions use three numeric components: `major.minor.patch`. Increment major for a large change, minor for a new feature or feature enhancement, and patch for minor changes and fixes; reset lower components when incrementing a higher component. Every release must have a new version and summary.
