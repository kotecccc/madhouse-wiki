import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";

const playerId = "101";
const workerPath = fileURLToPath(
  new URL("./fixtures/bridge-attack-crash-worker.mjs", import.meta.url),
);

async function runCrashWindow(mode) {
  const directory = await mkdtemp(join(tmpdir(), `bridge-crash-${mode}-`));
  const markerPath = join(directory, "ready.marker");
  const cargoLogPath = join(directory, "fake-cargo.log");
  const child = spawn(process.execPath, [workerPath], {
    env: {
      PATH: process.env.PATH || "",
      BRIDGE_CRASH_DIRECTORY: directory,
      BRIDGE_CRASH_MARKER: markerPath,
      BRIDGE_CRASH_CARGO_LOG: cargoLogPath,
      BRIDGE_CRASH_MODE: mode,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const ready = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("READY:")) resolve();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (!stdout.includes("READY:"))
        reject(
          new Error(
            `crash_fixture_exited_early:${code}:${signal}:${stderr.slice(-2000)}`,
          ),
        );
    });
  });
  let timeout;
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(`crash_fixture_timeout:${mode}:${stderr.slice(-2000)}`),
            ),
          20_000,
        );
      }),
    ]);
    const marker = await readFile(markerPath, "utf8");
    assert.equal(
      marker,
      {
        admission: "admission_before_http_dispatch",
        "in-flight": "cargo_applied_before_reply",
        response: "response_before_result_commit",
      }[mode],
    );
    const closed = once(child, "close");
    child.kill("SIGKILL");
    const [code, signal] = await closed;
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");

    const store = createAutomationStateStore({ directory });
    try {
      const pending = store.read(playerId)?.assistant?.pending;
      assert.equal(pending?.kind, "attack");
      assert.equal(pending?.deliveryStatus, "dispatching");
      assert.equal(
        pending?.admission?.connectionId,
        "00000000-0000-4000-8000-000000000003",
      );
    } finally {
      store.close();
    }

    let cargoLog = "";
    try {
      cargoLog = await readFile(cargoLogPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    assert.equal(
      cargoLog.split("\n").filter(Boolean).length,
      mode === "admission" ? 0 : 1,
    );
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
}

test(
  "SIGKILL after durable dispatch admission preserves pending state before Cargo",
  { skip: process.platform === "win32" },
  async () => runCrashWindow("admission"),
);

test(
  "SIGKILL after fake Cargo applies an in-flight strike but before its reply preserves unknown pending state",
  { skip: process.platform === "win32" },
  async () => runCrashWindow("in-flight"),
);

test(
  "SIGKILL after the applied HTTP response but before result commit preserves pending state",
  { skip: process.platform === "win32" },
  async () => runCrashWindow("response"),
);
