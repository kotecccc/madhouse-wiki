# Telegram cutover preparation

The existing Telegram bot menu points to `https://madhouse-wiki.ru/`. On
2026-10-30 the public Wiki and Connector were still serving source revision
`218ed2112b35efe72ccaa67487ffe451001d0dd6`. The intended Wiki release is
`1.30.0`; the final source commit and image health markers must be checked at
activation. Existing automation, bridge state and witness volumes must remain
intact. Do not perform an automatic rollback to that old source after a new
journal has been created: it does not implement `bridge_attempts`.

The existing live Mac agent and public bridge channel were version `0.1.11`;
its relay did not advertise the connection-bound stop acknowledgement. Candidate
Python bridge `0.1.12` is built from
`035e23789dde86d4d06c689a7229d8c4aa26e88e`, a documentation-only version
update to the previously tested relay. The signed artifacts are in
`artifacts/bridge-channel-0.1.12/` locally; they have not been published or
installed. The source bundle `docs/fixtures/bridge-agent-0.1.12-candidate.bundle`
has SHA-256 `6bba2bddc7235953767a9b307f868b051c3bb433c479cf646ba653dda6eb395c`.
The live 0.1.11 signed manifest was verified using the existing channel key,
and its updater accepted the signed 0.1.12 release in a temporary state with a
local fake fetch. This does not prove installation or game behavior on a device.

The one-time journal-cutover guard in `vps-release-update.sh` advances the floor
after workers stop and refuses automatic rollback on a failed candidate. Before
cutover, retain a protected consistent backup of automation, bridge and witness
volumes while their writers are stopped; do not put secrets in logs or overwrite
newer state with a backup. Verify existing session and IPC keys, service
health, routing, owner leases and disk capacity, and follow
`game-data-release-acceptance.md`. A failure after the floor advances requires
investigation or roll-forward, not a restart of an old image that ignores the
new journal. The guard does not itself create a backup.
