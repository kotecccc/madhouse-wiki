import assert from "node:assert/strict";
import { VERSION } from "../../connector/protocol.js";

const [wikiOrigin, connectorOrigin, expectedCommit] = process.argv.slice(2);
const expectedWikiOrigin =
  process.env.SMOKE_WIKI_ORIGIN || "https://madhouse-wiki.ru";
const expectedConnectorOrigin =
  process.env.SMOKE_CONNECTOR_ORIGIN || "https://connect.madhouse-wiki.ru";
if (
  !wikiOrigin ||
  !connectorOrigin ||
  !/^[a-f0-9]{40}$/.test(expectedCommit || "")
)
  throw new Error("Pass the Wiki URL, connector URL, and full release SHA");

async function fetchReady(url) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      lastError = error;
      if (attempt < 39)
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

async function getJson(url) {
  const response = await fetchReady(url);
  const body = await response.json();
  return { response, body };
}

const wikiHealth = await getJson(`${wikiOrigin}/healthz`);
assert.equal(wikiHealth.response.status, 200);
assert.deepEqual(wikiHealth.body, {
  service: "wiki",
  sourceCommit: expectedCommit,
});
const wikiRelease = await getJson(`${wikiOrigin}/release.json`);
assert.equal(wikiRelease.response.status, 200);
assert.equal(wikiRelease.body.provider, "VPS");
assert.equal(wikiRelease.body.sourceCommit, expectedCommit);
assert.equal(wikiRelease.body.telegramConnector?.protocolVersion, VERSION);
assert.equal(
  wikiRelease.body.telegramConnector?.origin,
  expectedConnectorOrigin,
);
const wikiPage = await fetchReady(`${wikiOrigin}/`);
assert.equal(wikiPage.status, 200);
assert.match(wikiPage.headers.get("content-type") || "", /text\/html/u);
assert.match(await wikiPage.text(), /<div id="root">/u);
const privateApi = await fetchReady(`${wikiOrigin}/api/achievements`);
assert.equal(privateApi.status, 401);
const privateAutomation = await fetchReady(
  `${wikiOrigin}/api/automation/state`,
);
assert.equal(privateAutomation.status, 401);

const connectorHealth = await getJson(`${connectorOrigin}/healthz`);
assert.equal(connectorHealth.response.status, 200);
assert.deepEqual(connectorHealth.body, {
  service: "connector",
  sourceCommit: expectedCommit,
});
const connectorRelease = await getJson(`${connectorOrigin}/release.json`);
assert.equal(connectorRelease.response.status, 200);
assert.equal(connectorRelease.body.provider, "VPS");
assert.equal(connectorRelease.body.sourceCommit, expectedCommit);
assert.equal(connectorRelease.body.protocolVersion, VERSION);
assert.equal(connectorRelease.body.wikiOrigin, expectedWikiOrigin);
assert.equal(connectorRelease.body.connectorOrigin, expectedConnectorOrigin);
const connectorPage = await fetchReady(`${connectorOrigin}/`);
assert.equal(connectorPage.status, 200);
assert.match(connectorPage.headers.get("content-type") || "", /text\/html/u);
assert.ok(
  (connectorPage.headers.get("content-security-policy") || "").includes(
    `frame-ancestors ${expectedWikiOrigin} https://web.telegram.org`,
  ),
);
const connectorConfig = await getJson(`${connectorOrigin}/api/config`);
assert.equal(connectorConfig.response.status, 503);
assert.equal(connectorConfig.body.error, "connection_unavailable");

console.log("VPS image smoke checks passed for Wiki and connector");
