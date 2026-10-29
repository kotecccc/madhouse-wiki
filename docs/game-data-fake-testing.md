# Fake game and bridge verification

This guide runs the local fake checks for bridge transport recovery, owner bootstrap, stored snapshots, and the server coordinator. The automated checks do not use the real game, production account data, a browser, or a deployment; the separately described manual acceptance uses a browser against localhost only. Test state is synthetic and stored in temporary directories or local loopback servers.

## Requirements

- Node.js `24.x` and npm, as declared by `package.json`.
- Python 3 for the relay test. The relay and its unit tests use Python's standard library.
- Project dependencies installed with `npm ci` if `node_modules` is not already present. The JavaScript integration tests use the repository's `ws` dependency.

Run the commands from the repository root unless a command explicitly changes directory. The optional Python relay source is from the separate checkout at commit `9db18ce`:

`/Users/mac/.codex/worktrees/bridge-recovery-ack/madhouse-wiki-bridge`

That checkout is separate from the Wiki repository. Its relay tests stub the missing `credential_store` and `auto_update` imports; those stubs are test-only no-ops. The tests exercise the actual `agent/bridge.py` relay and stop-ack functions, but they do not test credential persistence or automatic updates. `tests/bridge/fixtures/python-relay.py` installs the same stub imports before loading the relay module for its loopback integration.

## Python relay stop acknowledgement

Run the six relay unit tests from the source checkout:

```sh
cd /Users/mac/.codex/worktrees/bridge-recovery-ack/madhouse-wiki-bridge/agent
python3 -m unittest -v test_bridge_stop_ack
```

They cover a valid connection-bound stop acknowledgement, malformed or generic close frames, a hung relay worker, expected socket shutdown, lost acknowledgement delivery, and the capability header. They use fake sockets; they do not open a game connection.

For the end-to-end loopback case, return to the Wiki repository root and set the test agent path:

```sh
cd /Users/mac/projects/madhouse-wiki
MADHOUSE_TEST_BRIDGE_AGENT=/Users/mac/.codex/worktrees/bridge-recovery-ack/madhouse-wiki-bridge/agent/bridge.py \
  node --test tests/bridge/tls-websocket-relay.integration.test.mjs
```

The test starts a local fake HTTPS game, local WebSocket gateway, and the Python relay process. In `python-stop` mode the fake game receives one POST and the request is cancelled before its response; the test checks the stop-ack path and that the uncertain operation remains fenced after restart. The relay test's normal `lost` and `rate-limited` cases also run without the Python agent path. Without `MADHOUSE_TEST_BRIDGE_AGENT`, Node marks only the Python-specific `python-stop` case as skipped; it does not silently exercise the Python client.

## Snapshot, bootstrap, and coordinator checks

These tests use fake `fetcher` responses, signed fixtures, in-memory clients, or loopback services plus temporary SQLite state:

```sh
node --test \
  scripts/account/snapshots.test.mjs \
  tests/account-snapshot-integration.test.mjs \
  tests/bridge/connector-bootstrap.integration.test.mjs \
  tests/bridge/automation-actor-recovery.integration.test.mjs \
  tests/bridge/bridge-mutation-snapshot-barrier.integration.test.mjs \
  tests/bridge/bridge-profile-read-single-flight.integration.test.mjs \
  tests/bridge/bridge-resource-observation.integration.test.mjs \
  tests/bridge/late-bridge-profile-snapshot-revision.test.mjs
```

Expected coverage:

- `account-snapshot-integration.test.mjs` restarts a local automation store, reads a saved identity while its fake upstream is offline, and verifies that queued intent or preferences do not cause a game POST.
- `snapshots.test.mjs` also checks that an empty saved resource and a missing one remain distinct after reopening SQLite with an expired game token, without calling the game.
- `connector-bootstrap.integration.test.mjs` exercises signed internal IPC with fake auth/profile responses. It checks an independent owner's bootstrap while another account remains fenced, rejects an invented lease, and keeps an already identified quarantined account blocked.
- `automation-actor-recovery.integration.test.mjs` exercises the actor, queue gate, coordinator, bridge account service, and SQLite across restart. The server performs a permitted read, retains the unresolved outcome, and does not replay the action POST. Its transport-stop evidence is supplied by the test fixture rather than a live relay.
- The snapshot barrier tests verify that fake mutations block stale snapshot writes and that delayed resource/profile responses cannot overwrite newer state.
- The single-flight test checks that compatible consumers share one bridge profile request while cancellation-scoped requests stay independent.

Run the lower-level scheduler, recovery-permit, and bridge account checks separately when changing dispatch or quarantine behavior:

```sh
node --test \
  scripts/game/direct-scheduler.test.mjs \
  scripts/game/bridge-recovery-permit.test.mjs \
  scripts/game/bridge-journal-integration.test.mjs \
  scripts/automation/bridge-attempt-store.test.mjs \
  tests/automation-state-store.test.mjs \
  tests/direct-vps-integration.test.mjs \
  tests/bridge/account-service.test.mjs
```

The journal and state-store tests also exercise an expired actor lease, a
different worker taking over, late transport callbacks and another restart.
The older worker cannot overwrite actor state or remove the restored fence.
The direct VPS integration also verifies that an upstream 429 establishes the
coordinator cooldown before the snapshot layer returns stale saved data.

The private recovery-only configuration can be checked without starting a
public bridge listener:

```sh
node --test --test-name-pattern='recovery-only' tests/bridge/vps-lab.test.mjs
```

In a configured VPS deployment, `MADHOUSE_BRIDGE_RECOVERY_ONLY=1` is set for
both Wiki and Connector with the existing bridge IPC key. Wiki must also use
the existing bridge state directory and separate witness; this mode refuses
to provision a replacement. Connector requires its Wiki identity verification
key. The mode retains private route and owner checks while the public bridge
adapter is disabled. This guide does not change deployment configuration.

## Process crash checks

```sh
node --test \
  tests/bridge/bridge-crash-recovery-harness.test.mjs \
  tests/bridge/automation-actor-crash-recovery.test.mjs
```

The crash harness kills and restarts a child Wiki transport process while its fake HTTPS server and WebSocket relay remain alive. The actor crash test kills the actual actor process with `SIGKILL` after a fake game POST is received, restarts it after the server lease expires, then checks that the durable attempt remains unresolved and the POST count stays at one. It also checks that local cancellation is retained. Because the actor is killed before a stop acknowledgement can be established, the test does not clear the fence or infer the fake game's final state.

## Full repository checks

After focused tests pass, run the repository's complete scripted validation and connector client build:

```sh
npm run check
npm run build:connector
```

`npm run check` runs data validation, ESLint, UI-kit lint, Prettier checks, the complete Node test suite, and the Wiki Vite build. `npm run build:connector` runs the connector Vite build. The test suite uses fake responses and local fixtures for game/bridge interactions; `validate:data` reads the repository's canonical local catalogue. Do not supply production credentials or configure a live game endpoint for this procedure.

## What the results establish

Passing fake tests establish only the modeled behavior exercised by those fixtures. They do not establish live game outcomes, public service state, production data correctness, browser appearance, client installation, or deployment behavior. The Python source at commit `9db18ce` is a local test input here; this guide does not install or publish it. Older bridge clients that do not advertise and complete the stop-ack exchange cannot provide that transport proof. Their attempts remain unresolved. No timeout, reconnect, negative read, or lost response authorizes replay of a game mutation or removal of its fence.

These checks are evidence for engineering review, not a release-readiness claim.

## Reproducible revisions

The acceptance code is Wiki `8c94c54fba480d01372e37ceb3fb6230bf2806b0`, based on the upstream merge at `8f1cd63` (upstream `218ed2112b35efe72ccaa67487ffe451001d0dd6`). The compatible Python relay is `9db18cede7ecc0a0ca1499d854fe5319a7a44bef`, based on `3f409d62b0c9979094c6079ee0dbe75a373fb1bf`. The tracked incremental bundle `docs/fixtures/bridge-recovery-ack.bundle` contains the relay commit; SHA-256 `278452570fbb76b694e37a3ca355b7b71f481989d7bfe2d31b78cdfd32728889`. It requires that base commit, available in the local bridge repository. The bundle contains tracked Git data, not untracked files from a worktree.

In separate copies, with the two local repositories present:

```sh
git clone --no-hardlinks /Users/mac/projects/madhouse-wiki /tmp/madhouse-wiki-acceptance
git -C /tmp/madhouse-wiki-acceptance checkout --detach 8c94c54fba480d01372e37ceb3fb6230bf2806b0
cd /tmp/madhouse-wiki-acceptance
npm ci
node scripts/catalogue/restore-seed.mjs
git clone --no-hardlinks --no-checkout /Users/mac/projects/madhouse-wiki-bridge /tmp/madhouse-bridge-acceptance
git -C /tmp/madhouse-bridge-acceptance fetch /tmp/madhouse-wiki-acceptance/docs/fixtures/bridge-recovery-ack.bundle HEAD:refs/heads/fake-relay
git -C /tmp/madhouse-bridge-acceptance checkout --detach 9db18cede7ecc0a0ca1499d854fe5319a7a44bef
MADHOUSE_TEST_BRIDGE_AGENT=/tmp/madhouse-bridge-acceptance/agent/bridge.py node --test tests/bridge/tls-websocket-relay.integration.test.mjs
```

The stop-ack change advertises the capability and echoes the connection-bound stop challenge only after that tunnel's relay worker stops. Old clients still connect normally, but cannot furnish this proof. Neither version proves what the game did with previously received bytes. The copied Python relay uses the test-only import stubs described above; this is not an installable bridge release.

## Interactive local fake Wiki

This is a limited **direct-route** harness for manual UI exploration; bridge recovery and Telegram session restoration are exercised by the separate automated tests below. The fake has two synthetic profiles and explicit responses for a small allowlist of GETs; unknown game routes return 501. It rejects all game mutations. Its Vite configuration removes the real game proxy and injects an in-process fake fetcher; other `/api/` routes return 404. It has no Connector, bridge gateway, or real game service address. Browser CSP blocks external connections and images; some catalogue images will therefore be absent. It does not alter production authentication.

From the Wiki checkout, in a terminal:

```sh
cd /tmp/madhouse-wiki-acceptance
FAKE_DIR=$(mktemp -d /tmp/madhouse-fake.XXXXXXXX)
printf 'Test data: %s\n' "$FAKE_DIR"
node scripts/dev/fake-game-stand.mjs "$FAKE_DIR"
```

The process prints the app address `http://127.0.0.1:43774/`, the mode file and a private token file. In another terminal, copy the **synthetic** token shown by `cat /tmp/madhouse-fake.XXXXXXXX/token` (replace with the printed directory), and enter it using the application's ordinary token login. Never use a real token. To check without a browser:

```sh
FAKE_DIR=/tmp/madhouse-fake.XXXXXXXX # replace with the directory printed above
curl -i http://127.0.0.1:43774/
curl -i http://127.0.0.1:43774/api/me # 401 without credentials
curl -i -H "Authorization: Bearer $(cat "$FAKE_DIR/token")" http://127.0.0.1:43774/api/me
```

After a successful profile read, `printf 'offline\n' > "$FAKE_DIR/mode"` simulates game unavailability and `printf '429\n' > "$FAKE_DIR/mode"` simulates rate limiting. To trigger a read rather than reuse the fresh cache:

```sh
curl -i -H "Authorization: Bearer $(cat "$FAKE_DIR/token")" \
  -H 'X-Madhouse-Snapshot-Refresh: live' http://127.0.0.1:43774/api/me
```

A retained profile can be returned as stale; inspect `X-Madhouse-Snapshot` and `X-Madhouse-Game-Status` as well as HTTP status. `printf 'online\n' > "$FAKE_DIR/mode"` restores the fake. For a strictly stored read replace the refresh header with `X-Madhouse-Stored-Only: 1`; it must not print a `FAKE GET` line. A missing stored section is distinct from a successfully stored empty array. The synthetic token expires after 24 hours; create a new test directory for a new session. This harness does not issue Wiki sessions after game-token expiry.

Stop with Ctrl-C in the server terminal. Restart with the same `node ... "$FAKE_DIR"` command to reuse its test snapshot and token. Reset only the test data after stopping, using the exact printed directory (never substitute a production path):

```sh
rm -r -- "$FAKE_DIR"
```

Bridge disconnect, old-client compatibility, unknown mutation and crash recovery are reproducible through the scripted loopback scenarios, not an interactive bridge in this harness:

```sh
MADHOUSE_TEST_BRIDGE_AGENT=/tmp/madhouse-bridge-acceptance/agent/bridge.py node --test \
  tests/bridge/tls-websocket-relay.integration.test.mjs \
  tests/bridge/bridge-crash-recovery-harness.test.mjs \
  tests/bridge/automation-actor-crash-recovery.test.mjs \
  tests/bridge/automation-actor-recovery.integration.test.mjs \
  tests/bridge/bridge-resource-observation.integration.test.mjs \
  tests/bridge/device-gateway.test.mjs tests/bridge/bridge-aware-fetch.test.mjs
```

Confirm `python-stop` ran and the test summary says zero skipped. The fake game receives the uncertain POST once; after crash it stays unresolved and is not repeated. Raw bridge 429 and `Retry-After` reach the live caller; the saved stale snapshot remains separately readable. For actual transport cooldown evidence see `scripts/game/direct-scheduler.test.mjs` and the relay test. The test harness supplies transport stop proof in the actor reconciliation test; the separate Python relay test verifies actual transport stop, not the same combined process.

## What testers can expect

- Missing snapshot: data is unavailable until an authorized read succeeds; an empty saved collection is a valid empty result, not a missing section. Stale/incomplete data can remain visible with an age or availability warning; it is not evidence of current game state.
- Expired game token: game operations require reconnection. An independently valid Wiki session can still read saved data and issue allowed local stop/cancel commands; the manual direct harness does not simulate issuance of that session.
- Offline bridge: bridge-routed live reads and actions fail closed; locally saved views and local stop/cancel remain available when the Wiki session is valid. An old bridge without stop-ack capability cannot provide the recovery transport proof.
- Lost mutation response: the account/device fence and checkpoint remain unresolved across restart; do not retry the mutation. Some narrowly scoped queued battle reads may be reconciled only after trusted stop acknowledgement and with the correct active owner/checkpoint. A stopped relay does not prove the game did not process already-received bytes.
- If automatic reconciliation is unavailable or insufficient, saved views and local stop/cancel remain usable where authorized, but affected game operations remain blocked and need manual investigation. A negative read or timeout is not universal evidence of a mutation's outcome.

## Acceptance result

On Wiki `8c94c54fba480d01372e37ceb3fb6230bf2806b0`, `npm run check` passed: 1782 tests passed, one Python-specific case skipped because the optional agent variable was absent; Wiki build passed. `npm run build:connector` passed. With the reconstructed bridge `9db18cede7ecc0a0ca1499d854fe5319a7a44bef` explicitly supplied, the relay tests passed 3/3 with zero skips, including `python-stop`; the relay unit tests passed 6/6. The combined Python relay and actor/transport recovery suite passed 6/6 with zero skips. A clean local clone was restored from the included catalogue seed and served the application, virtual catalogue and fake API over loopback; unauthenticated profile returned 401, fake profile and persisted stored read returned 200, and simulated 429 returned stale data on the snapshot route. No visual or real game verification was performed.

Before a production release: review and publish a complete signed bridge package and verify installation on intended devices; validate deployment configuration, credentials and migration/rollback separately; perform explicitly authorized real-game and browser/device acceptance; update the release version and changelog according to `AGENTS.md`. None of these are established by the fake stand.

## Local browser acceptance fixture

The stand also exposes `/__fake/connect` on its loopback port. This page explicitly opts the current browser into a **test-only** session bootstrap, using the real Wiki session authority with fixed synthetic keys and an encrypted synthetic account record. It is not present in production. Reload reissues the test Wiki session without a game request; logout disables this opt-in. A fresh synthetic automation record is seeded only in the chosen temporary directory. `GET /__fake/status` returns a count and method/path log of fake game calls without credentials. To avoid a running stand, pass another port as the third argument, for example `node scripts/dev/fake-game-stand.mjs "$FAKE_DIR" 43785`.

Supported mode values in `$FAKE_DIR/mode`: `online`, `offline`, `429`, `hold` (a fake upstream request waits for 30 seconds or cancellation), `expiring` (a synthetic game token expires after five seconds while Wiki session remains valid), and `wiki-only` (no game credential), and `ui-raid` (one synthetic invitation and synthetic prior observations to exercise subscription controls). `/api/me`, `/api/me/bag`, `/api/combat`, and `/api/bosses/invitations` have explicit fixtures; unsupported game paths return 501. A second synthetic token in `token-b` gives an independent profile. None of these credentials or test keys are suitable outside this localhost stand.

The `ui-raid` mode exposes a synthetic invitation with three test observations; open the raid card and select `Подписаться` to enqueue it. All game POSTs remain rejected. Alternatively, for the selected no-mutation automation scenario, after the fake profile has been read once, issue `subscription.start` with a synthetic leader username and boss ID 1 through the normal server command API. The stored Wiki state supplies the current `expectedVersion`; an initial identity discovery can change it, in which case reread state before retrying the _command_ only if it was rejected with `automation_state_changed`. This is not permission to retry a dispatched game mutation. The queue UI displays the server subscription after reload and permits `subscription.stop`. `hold` can verify local stop while a fake game read is pending. It is an in-flight fake request, not a faithful model of the production executor's full scheduling; its pacing and uncertain dispatch are covered by the existing scheduler and crash tests.

The recovery UI never infers an operation type absent from the stored journal. When a single durable attempt corresponds to a supported queue action it identifies that action; otherwise it says the type cannot be determined. A transport stop cannot resolve an arbitrary game result.
