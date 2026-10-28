/** Obtain Wiki-signed launch data when the Wiki was opened outside Telegram. */
export async function connectorWikiIdentity({ existing, client, wikiOrigins }) {
  if (typeof existing === "string" && existing) return existing;
  if (typeof client?.openWebview !== "function" || !Array.isArray(wikiOrigins))
    throw new Error("invalid_wiki_identity");
  const launch = await client.openWebview({
    bot: "madhouse_wiki_bot",
    platform: "web",
    webview: { type: "main" },
  });
  let url;
  try {
    url = new URL(launch.url);
  } catch {
    throw new Error("invalid_wiki_identity");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !wikiOrigins.includes(url.origin)
  )
    throw new Error("invalid_wiki_identity");
  const data = new URLSearchParams(url.hash.slice(1)).get("tgWebAppData");
  if (!data || data.length > 8192) throw new Error("invalid_wiki_identity");
  // The server verifies Telegram's signature and compares this identity to the game launch.
  return data;
}
