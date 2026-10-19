# Knowledge base

The JSON files in this directory are the canonical content source. `index.js` imports them and exports the assembled `knowledgeBase` object directly; it does not transform or project entity records.

## Canonical files

- `metadata.json` stores `schemaVersion` and the dataset description.
- `sources.json` stores source records and their verification notes.
- `assets.json` stores shared asset metadata, including the legacy boss image map.
- `floors.json` stores floors and their ordered `departmentIds`.
- `departments.json` stores department facts and opening conditions.
- `bosses.json` stores boss facts, including each `departmentId`.
- `businesses.json` and `business-upgrades.json` store department-linked business data.

## Relationships

Use stable IDs to connect records. Floors own an ordered `departmentIds` list, and each department points back to its floor through `floorId`. Bosses, businesses, and business upgrades point to a department through `departmentId`. Opening conditions retain their source wording and type: `work_completions` uses `targetDepartmentId`, `boss_kills` uses `targetBossId`, and `business_level` uses `targetBusinessId`. An unresolved target may remain `null` with its `unresolvedTarget` note; preserve that uncertainty rather than inventing a relation.

Names and relations belong in their entity records. Preserve source references, verification state, raw wording, and explicit uncertainty. Do not add account-specific current counts, completion flags, progress, access, or business lock states. Keep IDs stable and update references when an ID must change.

Business upgrades use `businessId` to reference the existing matching business in their department. A null ID preserves an unmatched source record; the UI displays its table separately. These IDs replace the previous UI join by department and name. All original source fields and array orders are unchanged.
