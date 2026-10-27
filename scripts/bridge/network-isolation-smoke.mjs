import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const docker = (args) =>
  execFile("docker", args, {
    cwd: process.cwd(),
    maxBuffer: 4 * 1024 * 1024,
  });
const delay = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
const wikiRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const bridgeRoot = process.env.MADHOUSE_BRIDGE_REPO
  ? resolve(process.env.MADHOUSE_BRIDGE_REPO)
  : null;
const requestedImage = process.env.MADHOUSE_BRIDGE_ISOLATION_IMAGE;
if (
  !bridgeRoot ||
  !existsSync(`${bridgeRoot}/apps/desktop/src/main/gateway-client.mjs`)
)
  throw new Error("bridge_isolation_repo_required");
if (!requestedImage) throw new Error("bridge_isolation_image_required");

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const controlNetwork = `mhbi-${suffix}-control-net`;
const cargoNetwork = `mhbi-${suffix}-cargo-net`;
const cargoContainer = `mhbi-${suffix}-cargo`;
const wikiContainer = `mhbi-${suffix}-wiki`;
const desktopContainer = `mhbi-${suffix}-desktop`;
let imageId;
let nodeVersion;
let desktopIp;
const createdNetworks = [];
const createdContainers = [];

async function containerLogs(name) {
  try {
    const { stdout, stderr } = await docker(["logs", name]);
    return `${stdout}${stderr}`;
  } catch {
    return "";
  }
}

async function waitForLog(name, marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const logs = await containerLogs(name);
    if (logs.includes(marker)) return logs;
    const state = await docker(["inspect", name]);
    if (!JSON.parse(state.stdout)[0].State.Running)
      throw new Error(`${name}_exited_before_${marker}`);
    await delay(100);
  }
  throw new Error(`${name}_timeout_waiting_for_${marker}`);
}

async function waitForExit(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = JSON.parse((await docker(["inspect", name])).stdout)[0].State;
    if (!state.Running) return state.ExitCode;
    await delay(100);
  }
  throw new Error(`${name}_did_not_finish`);
}

async function stopAndRemove(name) {
  try {
    await docker(["stop", "--time", "2", name]);
  } catch {
    /* The container may already have exited. */
  }
  try {
    await docker(["rm", "--force", name]);
  } catch {
    /* The container may not have been created. */
  }
}

try {
  imageId = (
    await docker(["image", "inspect", "--format", "{{.Id}}", requestedImage])
  ).stdout.trim();
  nodeVersion = (
    await docker([
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "node",
      imageId,
      "--version",
    ])
  ).stdout.trim();
  if (!/^v24\./u.test(nodeVersion))
    throw new Error("bridge_isolation_requires_node_24");

  await docker([
    "network",
    "create",
    "--internal",
    "--label",
    "com.madhouse.bridge-isolation=t15",
    controlNetwork,
  ]);
  createdNetworks.push(controlNetwork);
  await docker([
    "network",
    "create",
    "--internal",
    "--label",
    "com.madhouse.bridge-isolation=t15",
    cargoNetwork,
  ]);
  createdNetworks.push(cargoNetwork);

  await docker([
    "run",
    "--detach",
    "--name",
    cargoContainer,
    "--network",
    cargoNetwork,
    "--network-alias",
    "cargohustle.online",
    "--volume",
    `${wikiRoot}:/wiki:ro`,
    "--workdir",
    "/wiki",
    "--entrypoint",
    "node",
    imageId,
    "/wiki/scripts/bridge/network-isolation/cargo-worker.mjs",
  ]);
  createdContainers.push(cargoContainer);
  await waitForLog(cargoContainer, "CARGO_READY", 10_000);
  const cargoInfo = JSON.parse(
    (await docker(["inspect", cargoContainer])).stdout,
  )[0];
  const cargoIp = Object.values(cargoInfo.NetworkSettings.Networks)[0]
    ?.IPAddress;
  assert.match(cargoIp || "", /^\d+\.\d+\.\d+\.\d+$/u);

  await docker([
    "create",
    "--name",
    wikiContainer,
    "--network",
    controlNetwork,
    "--network-alias",
    "wiki",
    "--add-host",
    `cargohustle.online:${cargoIp}`,
    "--volume",
    `${wikiRoot}:/wiki:ro`,
    "--volume",
    `${bridgeRoot}:/bridge:ro`,
    "--workdir",
    "/wiki",
    "--entrypoint",
    "node",
    imageId,
    "/wiki/scripts/bridge/network-isolation/wiki-worker.mjs",
  ]);
  createdContainers.push(wikiContainer);

  await docker([
    "create",
    "--name",
    desktopContainer,
    "--network",
    controlNetwork,
    "--network-alias",
    "desktop-relay",
    "--volume",
    `${wikiRoot}:/wiki:ro`,
    "--volume",
    `${bridgeRoot}:/bridge:ro`,
    "--workdir",
    "/bridge",
    "--entrypoint",
    "node",
    imageId,
    "/wiki/scripts/bridge/network-isolation/desktop-worker.mjs",
  ]);
  createdContainers.push(desktopContainer);
  await docker(["network", "connect", cargoNetwork, desktopContainer]);

  await docker(["start", wikiContainer]);
  await waitForLog(wikiContainer, "WIKI_READY", 10_000);
  await docker(["start", desktopContainer]);
  await waitForLog(desktopContainer, "DESKTOP_READY", 10_000);
  const cargoNetworkAtReady = JSON.parse(
    (await docker(["network", "inspect", cargoNetwork])).stdout,
  )[0];
  const desktopEndpoint = Object.values(cargoNetworkAtReady.Containers).find(
    (container) => container.Name === desktopContainer,
  );
  desktopIp = desktopEndpoint?.IPv4Address?.split("/")[0];
  assert.match(desktopIp || "", /^\d+\.\d+\.\d+\.\d+$/u);
  const cargoNetworkMembers = Object.values(cargoNetworkAtReady.Containers).map(
    (container) => container.Name,
  );
  assert.ok(cargoNetworkMembers.includes(cargoContainer));
  assert.ok(cargoNetworkMembers.includes(desktopContainer));
  assert.ok(!cargoNetworkMembers.includes(wikiContainer));

  const exitCode = await waitForExit(wikiContainer, 25_000);
  const wikiLogs = await containerLogs(wikiContainer);
  if (exitCode !== 0)
    throw new Error(`wiki_worker_failed:${wikiLogs.slice(-4000)}`);

  const resultLine = wikiLogs
    .split(/\r?\n/u)
    .find((line) => line.startsWith("T15_RESULT "));
  assert.ok(resultLine, "t15_result_missing");
  const result = JSON.parse(resultLine.slice("T15_RESULT ".length));
  assert.equal(result.directProbe.connected, false);
  assert.equal(result.directTransportCalls, 0);
  assert.equal(result.playerId, 54321);

  const cargoLogs = await containerLogs(cargoContainer);
  const requests = cargoLogs
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("CARGO_REQUEST "))
    .map((line) => JSON.parse(line.slice("CARGO_REQUEST ".length)));
  assert.equal(requests.length, 1);
  assert.deepEqual(
    {
      method: requests[0].method,
      path: requests[0].path,
      servername: requests[0].servername,
      authorized: requests[0].authorized,
    },
    {
      method: "GET",
      path: "/api/me",
      servername: "cargohustle.online",
      authorized: true,
    },
  );
  const cargoTcpConnections = cargoLogs
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("CARGO_TCP "))
    .map((line) => JSON.parse(line.slice("CARGO_TCP ".length)));
  assert.equal(cargoTcpConnections.length, 1);
  assert.ok(
    [desktopIp, `::ffff:${desktopIp}`].includes(
      cargoTcpConnections[0].remoteAddress,
    ),
    "fake_cargo_connection_did_not_originate_from_desktop_relay",
  );

  console.log(
    `T15_PASS ${JSON.stringify({
      imageId,
      nodeVersion,
      cargoRequests: requests.length,
      cargoPeer: desktopIp,
      wikiDirectProbe: result.directProbe.reason,
      directTransportCalls: result.directTransportCalls,
    })}`,
  );
} catch (error) {
  for (const name of [wikiContainer, desktopContainer, cargoContainer]) {
    const logs = await containerLogs(name);
    if (logs) console.error(`${name}_LOGS\n${logs.slice(-5000)}`);
  }
  throw error;
} finally {
  for (const name of createdContainers.reverse()) await stopAndRemove(name);
  for (const name of createdNetworks.reverse()) {
    try {
      await docker(["network", "rm", name]);
    } catch {
      /* The network may already have been removed by Docker. */
    }
  }
}
