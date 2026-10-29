import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repository = resolve(import.meta.dirname, "..");
const updater = join(repository, "scripts/deploy/vps-release-update.sh");
const candidate = "a".repeat(40);
const previous = "b".repeat(40);

function fixture({
  priorSha = previous,
  priorPreviousSha = null,
  stopFailures = [],
  upFailures = [],
  sleepFailures = [],
  freeKb = 10_000_000,
  dfFailure = false,
  inventoryFailure = false,
  probeFailure = false,
  checkSpace = false,
  malformedMarker = false,
  freeAfterCleanupKb = null,
  freeAfterDownloadKb = null,
  flockFailure = false,
  notificationFailure = false,
  floorSha = null,
  compareMode = "ahead",
  floorChangeAtProbe = null,
  floorChangeOnUp = null,
  bridgeEnabled = false,
  bridgeConfigured = true,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "vps-release-update-test-"));
  const root = join(directory, "root");
  const bin = join(directory, "bin");
  mkdirSync(root);
  mkdirSync(bin);
  const dockerRoot = join(directory, "docker-root");
  mkdirSync(dockerRoot);
  const script = join(directory, "vps-release-update.sh");
  const source = readFileSync(updater, "utf8");
  assert.match(source, /readonly ROOT=\/opt\/madhouse-wiki/);
  writeFileSync(
    script,
    source.replace(
      "readonly ROOT=/opt/madhouse-wiki",
      `readonly ROOT='${root}'`,
    ),
  );
  chmodSync(script, 0o755);
  if (priorSha)
    writeFileSync(
      join(root, "release.env"),
      `MADHOUSE_RELEASE_SHA=${priorSha}\n`,
    );
  if (priorPreviousSha)
    writeFileSync(
      join(root, "previous-release.env"),
      `MADHOUSE_PREVIOUS_RELEASE_SHA=${priorPreviousSha}\n`,
    );
  if (floorSha)
    writeFileSync(
      join(root, "rollback-floor.env"),
      `MADHOUSE_MINIMUM_SAFE_RELEASE_SHA=${floorSha}\n`,
    );
  if (bridgeEnabled) {
    writeFileSync(join(root, "bridge-enabled"), "enabled\n");
    if (bridgeConfigured) {
      writeFileSync(join(root, "vps-bridge-compose.yml"), "services: {}\n");
      writeFileSync(join(root, "bridge.env"), "MADHOUSE_BRIDGE_IPC_KEY=test\n");
    }
  }
  if (malformedMarker)
    writeFileSync(
      join(root, "previous-release.env"),
      "MADHOUSE_RELEASE_SHA=bad\n",
    );

  const log = join(directory, "calls.log");
  const put = (name, contents) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${contents}\n`);
    chmodSync(path, 0o755);
  };
  put(
    "curl",
    `
out=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in --output) out=$2; shift 2 ;; https://*) url=$1; shift ;; *) shift ;; esac
done
case "$url" in
  https://api.github.com/*/compare/*)
    [ '${compareMode}' = 'network-error' ] && exit 22
    pair=\${url##*/}; base=\${pair%%...*}; head=\${pair#*...}; head=\${head%%\\?*}
    status='${compareMode}'; merge="$base"; ahead=2; behind=0
    [ "$status" = 'long-history' ] && { status=ahead; ahead=300; }
    [ "$status" = 'single' ] && { status=ahead; ahead=1; }
    [ "$status" = 'behind' ] && { ahead=0; behind=1; }
    [ "$status" = 'diverged' ] && { merge='${"f".repeat(40)}'; behind=1; }
    total="$ahead"; [ "$status" = 'truncated' ] && { status=ahead; total=3; }
    printf '{"base_commit":{"sha":"%s"},"commits":[{"sha":"%s"}],"total_commits":%s,"merge_base_commit":{"sha":"%s"},"status":"%s","ahead_by":%s,"behind_by":%s}\n' "$base" "$head" "$total" "$merge" "$status" "$ahead" "$behind" >"$out"
    ;;
  https://api.github.com/*/git/commits/*)
    head=\${url##*/}
    printf '{"sha":"%s","parents":[{"sha":"%s"}]}\n' "$head" '${floorSha || ""}' >"$out"
    ;;
  https://api.github.com/*)
    cat >"$out" <<'JSON'
{"test":"fixture"}
JSON
    ;;
  *sha256) printf '%064d  madhouse-wiki-image.tar.gz\\n' 0 >"$out" ;;
  *) : >"$out" ;;
esac
case "$url" in *madhouse-wiki-image.tar.gz) : >'${directory}/downloaded' ;; esac
printf 'curl %s\\n' "$url" >>'${log}'`,
  );
  put(
    "python3",
    `if [ "$#" -ge 4 ]; then exec /usr/bin/python3 "$@"; fi
printf '%s\\n' \\
  'https://github.com/kotecccc/madhouse-wiki/releases/download/test/madhouse-wiki-image.tar.gz' \\
  'https://github.com/kotecccc/madhouse-wiki/releases/download/test/madhouse-wiki-image.tar.gz.sha256' \\
  '${candidate}'`,
  );
  put("sha256sum", "exit 0");
  put("flock", `[ '${flockFailure}' = true ] && exit 1; exit 0`);
  put(
    "df",
    `
[ '${dfFailure}' = true ] && exit 1
count_file='${directory}/df-count'; count=0
[ ! -f "$count_file" ] || read count <"$count_file"
count=$((count + 1)); printf '%s\\n' "$count" >"$count_file"
available=${freeKb}
if [ '${freeAfterCleanupKb}' != null ] && [ -f '${directory}/image-removed' ]; then available=${freeAfterCleanupKb}; fi
if [ '${freeAfterDownloadKb}' != null ] && [ -f '${directory}/downloaded' ]; then available=${freeAfterDownloadKb}; fi
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/test 10000000 1 %s 1%% /\\n' "$available"`,
  );
  put(
    "sleep",
    `
printf 'sleep %s\\n' "$*" >>'${log}'
count_file='${directory}/sleep-count'
count=0
[ ! -f "$count_file" ] || read count <"$count_file"
printf '%s\\n' "$((count + 1))" >"$count_file"
case " ${sleepFailures.join(" ") || "-1"} " in *" $count "*) exit 1 ;; esac`,
  );
  put(
    "docker",
    `
printf 'docker %s\\n' "$*" >>'${log}'
case "$*" in *release-notification.mjs*) [ '${notificationFailure}' = true ] && exit 1; exit 0 ;; esac
action=
for arg do
  case "$arg" in stop|up|ls|inspect|create|rm|info|load) action=$arg ;; esac
done
if [ "$1" = image ] && [ "$2" = ls ]; then
  [ '${inventoryFailure}' = true ] && exit 1
  printf 'madhouse-wiki:vps-%s sha256:%064d\\n' '${candidate}' 10
  printf 'madhouse-wiki:vps-%s sha256:%064d\\n' '${previous}' 11
  printf 'madhouse-wiki:vps-%s sha256:%064d\\n' '${"c".repeat(40)}' 12
  printf 'madhouse-wiki:vps-%s sha256:%064d\\n' '${"d".repeat(40)}' 2
  printf 'madhouse-wiki:vps-%s sha256:%064d\\n' '${"e".repeat(40)}' 3
  printf 'foreign:vps-%s sha256:%064d\\n' '${"e".repeat(40)}' 30
  printf 'madhouse-wiki:vps-%s sha256:%064d\\n' '${"1".repeat(40)}' 11
  printf '<none>:<none> sha256:%064d\\n' 4
  printf 'madhouse-wiki:latest sha256:%064d\\n' 5
  printf 'madhouse-wiki:vps-bad sha256:%064d\\n' 6
  printf 'madhouse-wiki:vps-%s sha256:%064d\\n' '${"f".repeat(40)}' 7
  exit 0
fi
if [ "$1" = info ]; then printf '%s\\n' '${dockerRoot}'; exit 0; fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
  [ '${inventoryFailure}' = true ] && exit 1
  image_ref=$3; [ "$#" -lt 5 ] || image_ref=$5
  case "$image_ref" in
    madhouse-wiki:vps-${candidate}) printf 'sha256:%064d\\n' 10 ;;
    madhouse-wiki:vps-${previous}) printf 'sha256:%064d\\n' 11 ;;
    madhouse-wiki:vps-${"c".repeat(40)}) printf 'sha256:%064d\\n' 12 ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [ "$1" = container ] && [ "$2" = ls ]; then
  [ '${inventoryFailure}' = true ] && exit 1
  printf 'deadbeef\\nfeedface\\n'; exit 0
fi
if [ "$1" = container ] && [ "$2" = inspect ]; then
  [ '${inventoryFailure}' = true ] && exit 1
  case "$5" in deadbeef) printf 'sha256:%064d\\n' 2 ;; feedface) printf 'sha256:%064d\\n' 3 ;; *) exit 1 ;; esac
  exit 0
fi
if [ "$1" = image ] && [ "$2" = rm ]; then : >'${directory}/image-removed'; exit 0; fi
if [ "$1" = create ] && [ '${floorChangeAtProbe}' != null ]; then printf 'MADHOUSE_MINIMUM_SAFE_RELEASE_SHA=%s\\n' '${floorChangeAtProbe}' >'${root}/rollback-floor.env'; fi
if [ "$1" = create ] && [ '${probeFailure}' = true ]; then exit 1; fi
case "$action" in
  stop)
    count_file='${directory}/stop-count'; count=0
    [ ! -f "$count_file" ] || read count <"$count_file"
    printf '%s\\n' "$((count + 1))" >"$count_file"
    case " ${stopFailures.join(" ") || "-1"} " in *" $count "*) exit 1 ;; esac ;;
  up)
    count_file='${directory}/up-count'; count=0
    [ ! -f "$count_file" ] || read count <"$count_file"
    printf '%s\\n' "$((count + 1))" >"$count_file"
    if [ '${floorChangeOnUp}' != null ]; then printf 'MADHOUSE_MINIMUM_SAFE_RELEASE_SHA=%s\\n' '${floorChangeOnUp}' >'${root}/rollback-floor.env'; fi
    case " ${upFailures.join(" ") || "-1"} " in *" $count "*) exit 1 ;; esac ;;
  load) : >'${directory}/loaded' ;;
esac
[ -n "$action" ] || exit 97
exit 0`,
  );

  const args = checkSpace ? ["--check-space"] : [];
  const run = spawnSync("/bin/bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  const calls = existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
    : [];
  return {
    calls,
    marker: existsSync(join(root, "release.env"))
      ? readFileSync(join(root, "release.env"), "utf8")
      : null,
    previousMarker: existsSync(join(root, "previous-release.env"))
      ? readFileSync(join(root, "previous-release.env"), "utf8")
      : null,
    directory,
    run,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function lifecycle(calls) {
  return calls.flatMap((call) => {
    if (call.startsWith("sleep ")) return [call];
    if (!call.startsWith("docker ")) return [];
    const action = call.match(/(?:^| )(stop|up)(?: |$)/)?.[1];
    return action ? [action] : [];
  });
}

test("activation stops the worker and waits 16 seconds before candidate up", () => {
  const f = fixture();
  try {
    assert.equal(f.run.status, 0, `${f.run.stderr}\n${f.run.stdout}`);
    assert.deepEqual(lifecycle(f.calls), ["stop", "sleep 16", "up"]);
    assert.equal(f.marker, `MADHOUSE_RELEASE_SHA=${candidate}\n`);
  } finally {
    f.cleanup();
  }
});

test("same SHA is a no-op without stop, sleep, or up", () => {
  const f = fixture({ priorSha: candidate });
  try {
    assert.equal(f.run.status, 0, `${f.run.stderr}\n${f.run.stdout}`);
    assert.equal(f.calls.filter((call) => call.startsWith("curl ")).length, 1);
    assert.ok(f.calls[0].startsWith("curl https://api.github.com/"));
    assert.ok(!f.calls.some((call) => call.startsWith("docker ")));
    assert.ok(
      !lifecycle(f.calls).some((call) =>
        ["stop", "up", "sleep 16"].includes(call),
      ),
    );
    assert.equal(f.marker, `MADHOUSE_RELEASE_SHA=${candidate}\n`);
  } finally {
    f.cleanup();
  }
});

test("candidate stop failure preserves marker and starts neither candidate nor rollback", () => {
  const f = fixture({ stopFailures: [0] });
  try {
    assert.notEqual(f.run.status, 0);
    assert.deepEqual(lifecycle(f.calls), ["stop"]);
    assert.equal(f.marker, `MADHOUSE_RELEASE_SHA=${previous}\n`);
  } finally {
    f.cleanup();
  }
});

test("rollback stops the candidate, waits 16 seconds, then starts the previous release", () => {
  const f = fixture({ upFailures: [0] });
  try {
    assert.notEqual(f.run.status, 0);
    assert.deepEqual(lifecycle(f.calls), [
      "stop",
      "sleep 16",
      "up",
      "stop",
      "sleep 16",
      "up",
    ]);
    assert.equal(f.marker, `MADHOUSE_RELEASE_SHA=${previous}\n`);
  } finally {
    f.cleanup();
  }
});

test("rollback stop failure leaves the marker on candidate and does not start the previous worker", () => {
  const f = fixture({ stopFailures: [1], upFailures: [0] });
  try {
    assert.notEqual(f.run.status, 0);
    assert.deepEqual(lifecycle(f.calls), ["stop", "sleep 16", "up", "stop"]);
    assert.equal(f.marker, `MADHOUSE_RELEASE_SHA=${candidate}\n`);
    assert.equal(
      f.previousMarker,
      `MADHOUSE_PREVIOUS_RELEASE_SHA=${previous}\n`,
    );
  } finally {
    f.cleanup();
  }
});

test("first deployment stops with candidate environment and removes marker after failed activation", () => {
  const f = fixture({ priorSha: null, upFailures: [0] });
  try {
    assert.notEqual(f.run.status, 0);
    assert.deepEqual(lifecycle(f.calls), ["stop", "sleep 16", "up"]);
    assert.match(
      f.calls.find((call) => call.includes(" stop wiki")),
      /--env-file \/dev\/null/,
    );
    assert.equal(f.marker, null);
  } finally {
    f.cleanup();
  }
});

test("sleep failure after stop preserves marker and prevents candidate startup", () => {
  const f = fixture({ sleepFailures: [0] });
  try {
    assert.notEqual(f.run.status, 0);
    assert.deepEqual(lifecycle(f.calls), ["stop", "sleep 16"]);
    assert.equal(f.marker, `MADHOUSE_RELEASE_SHA=${previous}\n`);
  } finally {
    f.cleanup();
  }
});

test("previous marker advances on success and old previous marker returns on rollback", () => {
  const success = fixture({ priorPreviousSha: "c".repeat(40) });
  try {
    assert.equal(
      success.run.status,
      0,
      `${success.run.stderr}\n${success.run.stdout}`,
    );
    assert.equal(
      success.previousMarker,
      `MADHOUSE_PREVIOUS_RELEASE_SHA=${previous}\n`,
    );
  } finally {
    success.cleanup();
  }
  const rollback = fixture({
    priorPreviousSha: "c".repeat(40),
    upFailures: [0],
  });
  try {
    assert.notEqual(rollback.run.status, 0);
    assert.equal(
      rollback.previousMarker,
      `MADHOUSE_PREVIOUS_RELEASE_SHA=${"c".repeat(40)}\n`,
    );
  } finally {
    rollback.cleanup();
  }
});

test("low space cleans only exact Wiki release tags while retaining known markers and referenced images", () => {
  const f = fixture({ priorPreviousSha: "c".repeat(40), freeKb: 1 });
  try {
    const rm = f.calls.filter((call) => call.includes("image rm"));
    assert.deepEqual(
      rm,
      [`docker image rm madhouse-wiki:vps-${"f".repeat(40)}`],
      `${f.run.stderr}\n${f.run.stdout}\n${f.calls.join("\n")}`,
    );
  } finally {
    f.cleanup();
  }
});

test("insufficient space fails before download and activation, preserving both markers", () => {
  const f = fixture({ priorPreviousSha: "c".repeat(40), freeKb: 1 });
  try {
    assert.notEqual(f.run.status, 0);
    assert.ok(
      !f.calls.some(
        (call) =>
          call.startsWith("docker load") ||
          call.includes(" stop wiki") ||
          call.includes(" up "),
      ),
    );
    assert.equal(f.marker, `MADHOUSE_RELEASE_SHA=${previous}\n`);
    assert.equal(
      f.previousMarker,
      `MADHOUSE_PREVIOUS_RELEASE_SHA=${"c".repeat(40)}\n`,
    );
  } finally {
    f.cleanup();
  }
});

test("space check performs no download, load, create, stop, or up", () => {
  const f = fixture({ checkSpace: true });
  try {
    assert.equal(f.run.status, 0, `${f.run.stderr}\n${f.run.stdout}`);
    assert.ok(
      !f.calls.some(
        (call) =>
          call.startsWith("curl ") ||
          call.startsWith("docker load") ||
          call.startsWith("docker create ") ||
          /docker .* (stop|up)/.test(call),
      ),
    );
  } finally {
    f.cleanup();
  }
});

test("inventory failure and failed container probe fail closed before stopping", () => {
  const inventory = fixture({
    priorPreviousSha: "c".repeat(40),
    freeKb: 1,
    inventoryFailure: true,
  });
  try {
    assert.notEqual(inventory.run.status, 0);
    assert.ok(!lifecycle(inventory.calls).includes("stop"));
  } finally {
    inventory.cleanup();
  }
  const probe = fixture({ probeFailure: true });
  try {
    assert.notEqual(probe.run.status, 0);
    assert.ok(!lifecycle(probe.calls).includes("stop"));
    assert.ok(
      probe.calls.some((call) =>
        call.includes("container rm madhouse-wiki-image-check-"),
      ),
    );
  } finally {
    probe.cleanup();
  }
});

test("unknown retention never guesses and df failure fails closed", () => {
  const unknown = fixture({ priorPreviousSha: null, freeKb: 1 });
  try {
    assert.notEqual(unknown.run.status, 0);
    assert.ok(!unknown.calls.some((call) => call.includes("image rm")));
    assert.ok(!lifecycle(unknown.calls).includes("stop"));
  } finally {
    unknown.cleanup();
  }
  const df = fixture({ dfFailure: true });
  try {
    assert.notEqual(df.run.status, 0);
    assert.equal(df.calls.filter((call) => call.startsWith("curl ")).length, 1);
    assert.ok(
      df.calls.some((call) => call.startsWith("curl https://api.github.com/")),
    );
    assert.ok(
      !df.calls.some((call) => call.includes("madhouse-wiki-image.tar.gz")),
    );
    assert.ok(!lifecycle(df.calls).includes("stop"));
  } finally {
    df.cleanup();
  }
});

test("ample space skips pre-download cleanup", () => {
  const f = fixture({ priorPreviousSha: "c".repeat(40) });
  try {
    assert.equal(f.run.status, 0, `${f.run.stderr}\n${f.run.stdout}`);
    const archiveDownload = f.calls.findIndex((call) =>
      call.includes("madhouse-wiki-image.tar.gz"),
    );
    const firstCleanup = f.calls.findIndex((call) => call.includes("image rm"));
    assert.ok(archiveDownload >= 0);
    assert.ok(firstCleanup === -1 || firstCleanup > archiveDownload);
  } finally {
    f.cleanup();
  }
});

test("low space recovers after cleanup and succeeds", () => {
  const f = fixture({
    priorPreviousSha: "c".repeat(40),
    freeKb: 1,
    freeAfterCleanupKb: 10_000_000,
  });
  try {
    assert.equal(f.run.status, 0, `${f.run.stderr}\n${f.run.stdout}`);
    assert.deepEqual(lifecycle(f.calls), ["stop", "sleep 16", "up"]);
  } finally {
    f.cleanup();
  }
});

test("pre-load space failure occurs after download but before Docker load or activation", () => {
  const f = fixture({ freeAfterDownloadKb: 1 });
  try {
    assert.notEqual(f.run.status, 0);
    assert.ok(
      f.calls.some((call) => call.includes("madhouse-wiki-image.tar.gz")),
    );
    assert.ok(!f.calls.some((call) => call.startsWith("docker load")));
    assert.ok(!lifecycle(f.calls).includes("stop"));
  } finally {
    f.cleanup();
  }
});

test("flock contention exits without update calls", () => {
  const f = fixture({ flockFailure: true });
  try {
    assert.equal(f.run.status, 0);
    assert.deepEqual(f.calls, []);
  } finally {
    f.cleanup();
  }
});

test("malformed retention marker fails before download, cleanup, or stopping", () => {
  const f = fixture({
    malformedMarker: true,
    priorPreviousSha: "c".repeat(40),
  });
  try {
    assert.notEqual(f.run.status, 0);
    assert.ok(!f.calls.some((call) => call.startsWith("curl ")));
    assert.ok(!f.calls.some((call) => call.includes("image rm")));
    assert.ok(!lifecycle(f.calls).includes("stop"));
  } finally {
    f.cleanup();
  }
});

test("notifies once after healthy activation and notification failure cannot roll it back", () => {
  for (const notificationFailure of [false, true]) {
    const f = fixture({
      notificationFailure,
      priorPreviousSha: "c".repeat(40),
    });
    try {
      assert.equal(f.run.status, 0, f.run.stderr);
      const notifications = f.calls.filter((call) =>
        call.includes("release-notification.mjs"),
      );
      assert.equal(notifications.length, 1);
      assert.ok(
        f.calls.indexOf(notifications[0]) >
          f.calls.findIndex((call) => call.includes(" up ")),
      );
      assert.ok(f.calls.some((call) => call.includes("image rm")));
      assert.deepEqual(lifecycle(f.calls), ["stop", "sleep 16", "up"]);
    } finally {
      f.cleanup();
    }
  }
});

test("does not notify on no-op, check-space, rollback or failed activation", () => {
  for (const options of [
    { priorSha: candidate },
    { checkSpace: true },
    { upFailures: [0] },
    { stopFailures: [0] },
  ]) {
    const f = fixture(options);
    try {
      assert.ok(
        !f.calls.some((call) => call.includes("release-notification.mjs")),
      );
    } finally {
      f.cleanup();
    }
  }
});

test("rollback floor permits descendants and keeps rollback above the floor", () => {
  const f = fixture({ floorSha: previous, upFailures: [0] });
  try {
    assert.equal(f.run.status, 1);
    assert.deepEqual(lifecycle(f.calls), [
      "stop",
      "sleep 16",
      "up",
      "stop",
      "sleep 16",
      "up",
    ]);
    assert.equal(f.marker, `MADHOUSE_RELEASE_SHA=${previous}\n`);
  } finally {
    f.cleanup();
  }
});

test("bridge updates keep the overlay and stop both services together", () => {
  const f = fixture({ bridgeEnabled: true, floorSha: previous });
  try {
    assert.equal(f.run.status, 0, f.run.stderr);
    const calls = f.calls.filter((call) => call.includes("docker compose"));
    assert.ok(calls.some((call) => call.includes(" stop connector wiki")));
    assert.ok(
      calls
        .filter((call) => call.includes(" stop ") || call.includes(" up "))
        .every((call) => call.includes("vps-bridge-compose.yml")),
    );
  } finally {
    f.cleanup();
  }
});

test("bridge updates refuse missing overlay or rollback floor", () => {
  for (const options of [
    { bridgeEnabled: true, floorSha: previous, bridgeConfigured: false },
    { bridgeEnabled: true },
  ]) {
    const f = fixture(options);
    try {
      assert.notEqual(f.run.status, 0);
      assert.deepEqual(lifecycle(f.calls), []);
    } finally {
      f.cleanup();
    }
  }
});

test("rollback floor rejects older, diverged, and unverifiable candidates before stopping", () => {
  for (const compareMode of [
    "behind",
    "diverged",
    "network-error",
    "truncated",
  ]) {
    const f = fixture({ floorSha: previous, compareMode });
    try {
      assert.notEqual(f.run.status, 0, compareMode);
      assert.deepEqual(lifecycle(f.calls), [], compareMode);
      assert.equal(f.marker, `MADHOUSE_RELEASE_SHA=${previous}\n`);
    } finally {
      f.cleanup();
    }
  }
});

test("rollback floor verifies long histories without downloading file patches", () => {
  const f = fixture({ floorSha: previous, compareMode: "long-history" });
  try {
    assert.equal(f.run.status, 0, f.run.stderr);
    const calls = f.calls.filter((call) => call.includes("/compare/"));
    assert.ok(calls.some((call) => call.includes("per_page=1&page=2")));
    assert.ok(calls.some((call) => call.includes("per_page=1&page=300")));
  } finally {
    f.cleanup();
  }
});

test("a single descendant is verified through its immutable parent", () => {
  const f = fixture({ floorSha: previous, compareMode: "single" });
  try {
    assert.equal(f.run.status, 0, f.run.stderr);
    assert.ok(f.calls.some((call) => call.includes("/git/commits/")));
  } finally {
    f.cleanup();
  }
});

test("rollback floor refuses missing current release and malformed markers", () => {
  for (const options of [
    { floorSha: previous, priorSha: null },
    { floorSha: "bad" },
  ]) {
    const f = fixture(options);
    try {
      assert.notEqual(f.run.status, 0);
      assert.deepEqual(lifecycle(f.calls), []);
    } finally {
      f.cleanup();
    }
  }
});

test("floor changed during preparation stops before touching the running Wiki", () => {
  const f = fixture({ floorChangeAtProbe: previous });
  try {
    assert.notEqual(f.run.status, 0);
    assert.deepEqual(lifecycle(f.calls), []);
    assert.equal(f.marker, `MADHOUSE_RELEASE_SHA=${previous}\n`);
  } finally {
    f.cleanup();
  }
});

test("floor changed after failed candidate prevents unsafe automatic rollback", () => {
  const f = fixture({
    floorSha: previous,
    floorChangeOnUp: candidate,
    upFailures: [0],
  });
  try {
    assert.notEqual(f.run.status, 0);
    assert.deepEqual(lifecycle(f.calls), ["stop", "sleep 16", "up"]);
    assert.equal(f.marker, `MADHOUSE_RELEASE_SHA=${candidate}\n`);
  } finally {
    f.cleanup();
  }
});
