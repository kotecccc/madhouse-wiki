# Fake game and bridge verification

This guide runs the local fake checks for bridge transport recovery, owner bootstrap, stored snapshots, and the server coordinator. It does not use the real game, production account data, a browser, or a deployment. Test state is synthetic and stored in temporary directories or local loopback servers.

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
- `connector-bootstrap.integration.test.mjs` exercises signed internal IPC with fake auth/profile responses. It checks an independent owner's bootstrap while another account remains fenced, rejects an invented lease, and keeps an already identified quarantined account blocked.
- `automation-actor-recovery.integration.test.mjs` exercises the actor, queue gate, coordinator, bridge account service, and SQLite across restart. The server performs a permitted read, retains the unresolved outcome, and does not replay the action POST. Its transport-stop evidence is supplied by the test fixture rather than a live relay.
- The snapshot barrier tests verify that fake mutations block stale snapshot writes and that delayed resource/profile responses cannot overwrite newer state.
- The single-flight test checks that compatible consumers share one bridge profile request while cancellation-scoped requests stay independent.

Run the lower-level scheduler, recovery-permit, and bridge account checks separately when changing dispatch or quarantine behavior:

```sh
node --test \
  scripts/game/direct-scheduler.test.mjs \
  scripts/game/bridge-recovery-permit.test.mjs \
  tests/bridge/account-service.test.mjs
```

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
