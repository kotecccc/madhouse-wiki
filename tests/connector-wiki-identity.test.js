import assert from "node:assert/strict";
import { test } from "node:test";
import { connectorWikiIdentity } from "../connector/wiki-identity.js";

test("existing Telegram launch needs no additional request", async () => {
  assert.equal(
    await connectorWikiIdentity({ existing: "signed-launch", client: null }),
    "signed-launch",
  );
});

test("outside Telegram obtains a Wiki launch using the logged-in Telegram client", async () => {
  let options;
  const result = await connectorWikiIdentity({
    wikiOrigins: ["https://wiki.example"],
    client: {
      openWebview: async (value) => {
        options = value;
        return { url: "https://wiki.example/#tgWebAppData=signed%26data" };
      },
    },
  });
  assert.equal(options.bot, "madhouse_wiki_bot");
  assert.equal(result, "signed&data");
});

test("rejects untrusted origins, URL credentials and missing launch data", async () => {
  for (const url of [
    "https://attacker.example/#tgWebAppData=signed",
    "https://user@wiki.example/#tgWebAppData=signed",
    "https://wiki.example/",
    "not a URL",
  ]) {
    await assert.rejects(
      connectorWikiIdentity({
        wikiOrigins: ["https://wiki.example"],
        client: { openWebview: async () => ({ url }) },
      }),
      { message: "invalid_wiki_identity" },
    );
  }
});
