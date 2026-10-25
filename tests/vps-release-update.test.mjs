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
  stopFailures = [],
  upFailures = [],
  sleepFailures = [],
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "vps-release-update-test-"));
  const root = join(directory, "root");
  const bin = join(directory, "bin");
  mkdirSync(root);
  mkdirSync(bin);
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
  https://api.github.com/*)
    cat >"$out" <<'JSON'
{"test":"fixture"}
JSON
    ;;
  *sha256) printf '%064d  madhouse-wiki-image.tar.gz\\n' 0 >"$out" ;;
  *) : >"$out" ;;
esac`,
  );
  put(
    "python3",
    `printf '%s\\n' \\
  'https://github.com/kotecccc/madhouse-wiki/releases/download/test/madhouse-wiki-image.tar.gz' \\
  'https://github.com/kotecccc/madhouse-wiki/releases/download/test/madhouse-wiki-image.tar.gz.sha256' \\
  '${candidate}'`,
  );
  put("sha256sum", "exit 0");
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
action=
for arg do
  case "$arg" in stop|up) action=$arg ;; esac
done
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
    case " ${upFailures.join(" ") || "-1"} " in *" $count "*) exit 1 ;; esac ;;
esac
exit 0`,
  );

  const run = spawnSync("/bin/bash", [script], {
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
    assert.deepEqual(f.calls, []);
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
