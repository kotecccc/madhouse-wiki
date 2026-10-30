# Local game-data release candidate, 2026-10-30

This is a local candidate, not a production release. No image, key, or package
was published and no installed bridge or real game was contacted. The Wiki and
Connector use the same source revision and image.

- Wiki and Connector code: `d701017a8b626077519721e0c6cb536284554d52`, app version `1.29.5`, Wiki/Connector handshake protocol `2`.
- Previous acceptance documentation: `16c72a29c114d4449d81cae41deccd281c82fd66`.
- Complete Python bridge source: `8cc2663a925683f335691a40c5fd0499aaf4be14`; its ancestor `9db18cede7ecc0a0ca1499d854fe5319a7a44bef` supplies the connection-bound relay stop acknowledgement.
- Python bridge candidate: `0.1.9`, after a locally prepared 0.1.8 whose publication was not confirmed. Both builders and updater accept numeric `major.minor.patch` only, so no prerelease suffix is supported. This is an application package version, not a protocol version. The separate Electron application is 0.1.0 and its shared protocol package is 1.4.8. Stop acknowledgement proves worker termination, never the outcome of game bytes already sent.
- Source bundle: `docs/fixtures/bridge-agent-0.1.9-candidate.bundle`, SHA-256 `ed96290e51de3a96ee9c441db7ca567db9b7ee36936e1b2ee8aed79ef094588f`. It contains complete Git history; the candidate commit records the uncommitted source snapshot provenance. No private keys, certificates, generated verifier, or user worktree outputs are included.

## Local packages and trust

The earlier artifacts in this table use a disposable **test** Ed25519 key, not the production
trust anchor. The separately prepared channel-signed artifacts and verification are recorded in [the signing handoff](game-data-channel-signing.md). These files must not be installed on a user's device or published.
There is no available macOS code-signing identity (`security find-identity -v
-p codesigning` returned zero); Developer ID/notarization and trusted package
signing remain unperformed. Test-key artifacts cannot update an installation
that trusts a different key. They are temporary files, not permanent hosting.

| Local artifact                                                             | SHA-256                                                            |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `/tmp/madhouse-bridge-rc-019-macos-final/MadhouseWikiBridge.command`       | `9aaa62c7523bdfe93c4a5b28d0c3df1a5a29759dfde919b97961b0d7629b497b` |
| `/tmp/madhouse-bridge-rc-019-macos-final/bootstrap.pyz`                    | `e46533b642619f29c1423c6348c7186ceb4b388448d17eb0c8fb1ad93ed1f01e` |
| `/tmp/madhouse-bridge-rc-019-macos-final/releases/madhouse-bridge.pyz`     | `65328786c04cd7a53958b0f8a36e659412906a48f736afe5f2f2bb93217e9f38` |
| `/tmp/madhouse-bridge-rc-019-windows-final/MadhouseWikiBridge-Windows.zip` | `e88dbd7e8609536a451cd9109bc0e66cd5259b7f6cb44033a1c8b5558ccc900c` |
| `/tmp/madhouse-bridge-rc-019-windows-final/bootstrap.pyz`                  | `a5e73cc2b5b63dbff51ce476a67895a87b7582ff1a459482c7d15a869b9d132c` |
| `/tmp/madhouse-bridge-rc-019-windows-final/releases/madhouse-bridge.pyz`   | `383ea33f069d31b00ef3ce7738497f12c8f1cc750d9a1e8e47c0d88af5085f7a` |

The macOS launcher and shared zipapp use a generated universal verifier:
arm64 macOS 12+ and x86_64 macOS 13+. The launcher `--check`, Python agent
`--help`, and test-manifest verification passed on this Mac. The Windows ZIP
contains x86_64 Python 3.13.16 embeddable runtime, bootstrap and BAT launcher;
the pinned upstream runtime SHA-256 is
`97dae5274cc54867065e8d5a3226e48c35017ed332a0fdb0e27d5b5821961297`.
The signed manifest and macOS release report display version 0.1.9; the agent help has no version flag. The relay bytes in both packages equal the candidate source. Windows runtime
tests passed under Wine with a fresh isolated prefix and fake signed releases;
this is not an installation or test on Windows hardware. Alpine 3.14 Docker
compatibility passed with synthetic signed data; it is not a physical iOS/iSH
check. The Mac linker warned that a Swift compatibility archive lacked x86_64;
`lipo` confirms both slices are present but native Intel execution remains
unverified.

Both builds were repeated from separately checked-out source using the same
test key. The Mac launcher, bootstrap and agent hashes matched; Windows agent
and bootstrap hashes matched, but the ZIP changed because its archive metadata
is not deterministic. Do not claim the Windows archives are byte reproducible.

## Rebuild and verification

From a clean clone of the source bundle, using an explicitly supplied local
signing key and public key, and a separately supplied verified Python runtime:

```sh
git clone docs/fixtures/bridge-agent-0.1.9-candidate.bundle /tmp/bridge-candidate-source
git -C /tmp/bridge-candidate-source checkout --detach 8cc2663a925683f335691a40c5fd0499aaf4be14
cd /tmp/bridge-candidate-source
sh agent/build_macos_verifier.sh
python3 agent/release.py --output /tmp/bridge-mac-output --version 0.1.9 --signing-key "$BRIDGE_SIGNING_KEY" --public-key "$BRIDGE_PUBLIC_KEY"
python3 agent/build_macos_launcher.py --bootstrap /tmp/bridge-mac-output/bootstrap.pyz --output /tmp/bridge-mac-output/MadhouseWikiBridge.command
python3 agent/windows/build_release.py --output /tmp/bridge-win-output --version 0.1.9 --private-key "$BRIDGE_SIGNING_KEY" --public-key "$BRIDGE_PUBLIC_KEY" --python-zip "$PYTHON_EMBED_ZIP"
/tmp/bridge-mac-output/MadhouseWikiBridge.command --check
python3 agent/package.py verify --artifact /tmp/bridge-mac-output/releases/madhouse-bridge.pyz --manifest /tmp/bridge-mac-output/releases/manifest.json --signature /tmp/bridge-mac-output/releases/manifest.sig --public-key "$BRIDGE_PUBLIC_KEY" --minimum-version 0.1.9
MADHOUSE_TEST_ALPINE_314=1 python3 -m unittest discover -s agent -p 'test_*.py'
```

The public key is embedded in each bootstrap and must match the approved trust
anchor for the intended channel. Build output directories must not exist.
The signing key must remain private and outside the source and output. Do not
reuse these test-key builds as production releases. For Windows native tests,
follow `agent/windows/README.md` and run the included fixtures on Windows.

Wiki/Connector build from the clean code checkout uses:

```sh
git clone /path/to/madhouse-wiki /tmp/wiki-candidate-source
git -C /tmp/wiki-candidate-source checkout --detach d701017a8b626077519721e0c6cb536284554d52
cd /tmp/wiki-candidate-source
docker build --platform linux/amd64 -f Dockerfile.vps --build-arg MADHOUSE_RELEASE_SHA=d701017a8b626077519721e0c6cb536284554d52 -t madhouse-wiki:local-candidate .
```

The build runs catalogue restoration, validations, tests and both frontend
builds; it does not generate Telegram cards. The previous full `npm run check`
and `npm run build:connector` apply to the same unchanged code. The focused
Python relay and actor/crash tests passed 6/6, zero skips, against the candidate
relay with a fake game and local transport. The Python suite passed 41/41,
including the opt-in Alpine test. Windows-specific fake credential and update
checks passed 2/2 in Wine after correcting the stale test expectation.

## Local image

The clean checkout produced local Docker image `madhouse-wiki:clean-rc-d701017`,
image ID `sha256:e17c1057cbfe4710033caf052cf810621f4ff51f4af78d0c876ed6d631e3dd11`
for `linux/amd64` (built under emulation on this arm64 Mac). Wiki and Connector
use that same image. This is a local image ID, not a registry digest. The earlier
acceptance image ID is `sha256:998146e5b067a473d8d443d0da800ef9b388df410aade8c1a5e5ef60967d6384`.

## Published-port smoke

Run the saved harness from a Wiki checkout with Node dependencies installed,
Docker, nginx:alpine, OpenSSL, curl and Python available:

```sh
SMOKE_IMAGE=madhouse-wiki:clean-rc-d701017 \
SMOKE_SHA=d701017a8b626077519721e0c6cb536284554d52 \
  docs/fixtures/wiki-container-auth-smoke.sh
```

It creates unique Docker networks, synthetic keys, a fake HTTPS storage service,
an encrypted synthetic account and a Wiki session, then removes its containers,
networks and temporary files. Wiki and Connector run on an internal network;
the temporary nginx connects it to a normal network and publishes localhost
ports. The standard `smoke-vps-image.mjs` passed through those ports including
both release markers, routing, unauthorized boundaries and Connector CSP. The
additional saved-state endpoint returned 401 without authorization and 200 with
the synthetic session. Connector's unavailable configuration response was also
checked by the standard smoke; this does not establish a positive Telegram login.
The internal-network external DNS probe failed `EAI_AGAIN`; no game endpoint or
mutation was requested. This tests synthetic storage and auth, not a deployed
reverse proxy or production secrets.

The earlier host-side failure was reproduced: Docker Desktop's published port
was unreachable when the ingress container was attached only to an internal
network; host access succeeds via a proxy attached to a normal network as well.
During harness development a duplicate proxy DNS alias also caused intermittent
503s; those aliases have been removed. Reusing an old synthetic automation DB
immediately after its worker stopped left a valid lease and caused
`automation_worker_unavailable`; the saved harness always creates fresh state.

## Release and rollback gates

Use [the release handoff](game-data-release-acceptance.md) and
[VPS deployment instructions](vps-deployment.md) before any deployment. Validate
actual routing, secrets, persistent account/automation/bridge/witness volumes,
exclusive workers and the exact previous image against synthetic state with an
unresolved journal. Do not start an older image on state it can ignore or erase,
overwrite a newer journal with an older backup, or replay an uncertain mutation.
A target-device installation check, separately authorized real deployment and real-game acceptance remain outstanding. Channel signatures have now been prepared locally as described in the signing handoff; platform code signing is a separate mechanism.
