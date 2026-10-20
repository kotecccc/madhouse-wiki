import { format } from "prettier";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CatalogueStore } from "./catalogue/store.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const store = new CatalogueStore(root);
try {
  store.initialize();
  const report = store.report();
  const statuses = store.db
    .prepare(
      "SELECT status,count(*) requests FROM captures GROUP BY status ORDER BY status",
    )
    .all();
  const missing = store.db
    .prepare(
      "SELECT to_kind,to_id,count(*) references_count FROM unresolved_links GROUP BY to_kind,to_id ORDER BY to_kind,to_id",
    )
    .all();
  const upgradeSummary = store.db
    .prepare(
      `SELECT count(*) AS recipes,
        coalesce(sum(json_array_length(json_extract(data_json,'$.items[0].levels'))),0) AS business_levels
       FROM entities WHERE kind='business_upgrade'`,
    )
    .get();
  const upgradeDisagreements = store.db
    .prepare(
      `SELECT coalesce(b.name,e.name,json_extract(e.data_json,'$.businessId')) AS business,
        json_extract(t.value,'$.itemName') AS item,
        json_extract(t.value,'$.declared') AS declared,
        json_extract(t.value,'$.computed') AS computed
       FROM entities e
       LEFT JOIN entities b ON b.kind='business' AND b.id=json_extract(e.data_json,'$.businessId'),
         json_each(e.data_json,'$.sourceTotals') t
       WHERE e.kind='business_upgrade' AND json_extract(t.value,'$.matches')=0
       ORDER BY e.id, item`,
    )
    .all();
  const rejectedFloors = report.captures
    .filter(
      (c) => c.status !== 200 && /^\/api\/floors\/[^/]+\/info$/.test(c.path),
    )
    .map((c) => decodeURIComponent(c.path.split("/")[3]))
    .join(", ");
  const counts = report.counts
    .map((r) => `| ${r.kind} | ${r.records} |`)
    .join("\n");
  const coverage = report.captures
    .map(
      (c) =>
        `| \`${c.path}\` | ${c.status} | ${c.entity_count} | ${c.captured_at} |`,
    )
    .join("\n");
  const disagreementText = upgradeDisagreements.length
    ? upgradeDisagreements
        .map((r) => `- ${r.business}: ${r.item} declared ${r.declared}, per-level sum ${r.computed}.`)
        .join("\n")
    : "- None recorded.";
  const text = `# Catalogue source coverage\n\nDatabase: \`local-data/madhouse.sqlite\`. Generated: ${report.updatedAt}.\n\nThe database contains filtered reference definitions from API responses and separately sourced user-provided business upgrade recipes. No legacy catalogue seed remains. Credentials, player identities, balances, ownership, access flags, completion counts and current progress are excluded. Public client routing discovers identifiers and membership with separate provenance; it does not supply definitions.\n\n## Entities\n\n| Kind | Records |\n| --- | ---: |\n${counts}\n\n## Source limits and user-provided recipes\n\n- API captures provide 48 business IDs in accessible floor summaries, but account-relative business detail responses do not establish global level-by-level requirements. Separately, ${upgradeSummary.recipes} user-provided business recipes cover ${upgradeSummary.business_levels} business levels. They were imported by \`node scripts/catalogue/import-user-upgrades.mjs\` from \`local-data/sources/user-business-upgrades-2026-10-20.md\`; these definitions are user-provided and not API-verified. Their per-level values are preserved, along with source-declared totals, including disagreements:\n${disagreementText}\n- Most recent floor-detail requests were rejected for: ${rejectedFloors || "none"}. Definitions from prior successful API responses are retained; no legacy files fill gaps.\n- The public client provides 39 work routes; 24 descriptions were returned. Floors without work routes are not assigned invented works.\n- Bank packages selected by account stage are omitted.\n- Weapon and pet IDs are discovered from API achievement catalogue keys; definitions come from their detail endpoints. This does not prove the absence of other unpublished entities.\n- Mutagen recipes and ornament catalogue members come from API definitions. Quest sections follow the eight public client chain buttons; only returned definitions are stored.\n- Boss portraits use the public client CDN asset route. Business-item images use activity_item entityId values embedded in each API boss record; boss IDs are not treated as item IDs.\n\nUnresolved targets: ${report.unresolvedLinks}.\n\n${missing.map((r) => `- ${r.to_kind} / ${r.to_id}: ${r.references_count} references`).join("\n")}\n\n## HTTP coverage\n\n${statuses.map((r) => `- HTTP ${r.status}: ${r.requests} requests`).join("\n")}\n\nStatus 0 indicates transport, parse or projection failure. A non-200 route does not contribute a definition. Captures preserve status and coverage, never the response body. User-provided upgrade records are outside HTTP capture coverage.\n\n| Route | HTTP | Projected entities | Captured UTC |\n| --- | ---: | ---: | --- |\n${coverage}\n`;
  writeFileSync(
    resolve(root, "local-data/catalogue-report.md"),
    await format(text, { parser: "markdown" }),
  );
  console.log(
    JSON.stringify(
      {
        database: report.database,
        counts: report.counts,
        statuses,
        unresolvedLinks: report.unresolvedLinks,
        report: "local-data/catalogue-report.md",
      },
      null,
      2,
    ),
  );
} finally {
  store.close();
}
