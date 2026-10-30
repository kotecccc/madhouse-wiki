# Bridge 0.1.9: channel-signing handoff

The Python bridge candidate is commit `8cc2663a925683f335691a40c5fd0499aaf4be14`.
On 2026-10-30 both Python agent packages were signed locally with the existing
channel key at `/Users/mac/projects/madhouse-wiki-bridge/.bridge-signing/private.pem`.
Its derived public key matched the adjacent `public.pem`, the public key embedded
in the existing local `~/.madhouse-bridge/bootstrap.pyz`, and the retained
`public-0.1.8` and `windows-0.1.0` bootstraps. The public key's DER SHA-256 is
`0281c8b0dd103e3dbee940916dabceb2f7cb2d9d50a0c043bf09eb7227eb81c7`.
These are local comparisons; they do not establish the current production
channel or every installed device's state. No private key or device credential
was copied, printed, or modified.

## What is signed and checked

`agent/package.py` signs the exact `manifest.json` bytes with Ed25519. The
manifest contains the version, filename, size and SHA-256 of the agent zipapp;
`manifest.sig` is the detached signature. The verifier checks the signature,
manifest schema, rollback floor and zipapp size and hash. The Windows builder
uses the same manifest contract; its Windows verifier uses the embedded Python
runtime's `libcrypto-3.dll`.

The bootstrap is built with the provided public key in `bootstrap_config.py`.
Its `install_from_fetch` downloads the three release files and invokes the
platform verifier before installation; the updater reads the trust anchor from
the locally retained bootstrap, verifies again and enforces the version floor.
The new launcher contains a bootstrap digest; `--check` only confirms embedded
bytes match that digest, **not** publisher identity. Secure distribution of the
launcher/bootstrap and independent verification of its public-key fingerprint
remain necessary. Wiki's release HTTP code checks a configured bootstrap hash
and file structure; it does not verify the Ed25519 release signature. The two
platform bootstraps fetch different URLs, and this handoff publishes neither.

The Ed25519 channel signature does not code-sign the launcher, bootstrap, ZIP,
or Python interpreter. The Mac builder does not call Developer ID signing or
notarization. Its universal Swift `macos_verify` helper was linker ad-hoc signed
(`codesign -dv` reports `adhoc`, no TeamIdentifier), not Developer ID signed.
No local code-signing identities were found. Their absence did **not** block the
Python bridge package or channel signature; Gatekeeper acceptance and
notarization have not been established. The Windows Python ZIP builder likewise
does not use Authenticode; no Windows native-device acceptance is claimed.
The separate Electron desktop project's signed release configuration requires
macOS signing identity and notarization credentials, or a Windows certificate
and x64 runner, respectively. That distinct release chain is not the Python
bridge package built here; its requirements do not imply these Python builders
have signed or notarized platform installers.

## Signed artifacts

Stored locally under `/Users/mac/projects/madhouse-wiki/artifacts/bridge-channel-0.1.9/`;
this ignored directory is not published or committed. The source checkout was a
clean clone of the bundle, and the macOS helper was built there from Swift.

| File                                     | SHA-256                                                            |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `macos/MadhouseWikiBridge.command`       | `b181266997b8c40b924372e15e3e69e3ae340b46de38f5a130441adb7210a796` |
| `macos/bootstrap.pyz`                    | `30c6912256882dc20f4a6e59a32426d4c33fef49a34c103d849828e93fc07d84` |
| `macos/releases/madhouse-bridge.pyz`     | `65328786c04cd7a53958b0f8a36e659412906a48f736afe5f2f2bb93217e9f38` |
| `macos/releases/manifest.json`           | `1adf5b060fb2f1c5c496c3137e83b28d7972461e862a3821ea9d8ab226ecd522` |
| `macos/releases/manifest.sig`            | `b7ceb70876707c687d6d21e96215aba852ec12a3efdf11ef30c90447b3cc97f5` |
| `windows/MadhouseWikiBridge-Windows.zip` | `c827d05306319105c895570dd7cb276fdb09bf67f704655e02e2c4badb10a007` |
| `windows/bootstrap.pyz`                  | `b6fab736122a2e6cde4c4bf56f24f5fa18b2514aef19eb9f7bd2e8cb7c38f77f` |
| `windows/releases/madhouse-bridge.pyz`   | `383ea33f069d31b00ef3ce7738497f12c8f1cc750d9a1e8e47c0d88af5085f7a` |
| `windows/releases/manifest.json`         | `fd1dc9d7f1e2ec2b11fbb5a8f4feb9e281d2ff530d275c32012a1fa9cb2732e5` |
| `windows/releases/manifest.sig`          | `792b8b9aab018e21cd247dca6c578cfe5bcd45cc6da7b1a53d4e35675200778e` |

The common `agent/package.py verify` passed for both signed triplets, and the
Windows-specific verifier passed under Wine with the Windows Python runtime.
The macOS launcher's `--check` passed. An isolated local macOS installation via
`install_from_fetch` using the signed package and embedded key succeeded, and
Wiki's fake TLS/WebSocket relay test passed 3/3 including `python-stop`. That
is not an installed-device, Windows, Gatekeeper, deployment or real-game test.
The source bundle is `docs/fixtures/bridge-agent-0.1.9-candidate.bundle`,
SHA-256 `ed96290e51de3a96ee9c441db7ca567db9b7ee36936e1b2ee8aed79ef094588f`.

## Reproduce or verify

Run from the Wiki checkout on macOS with Xcode command-line tools, Python 3 and
OpenSSL supporting Ed25519. Supply **existing** approved channel key paths; do
not generate a replacement. `PYTHON_EMBED_ZIP` is the official Windows x64
Python 3.13.16 embeddable ZIP, SHA-256
`97dae5274cc54867065e8d5a3226e48c35017ed332a0fdb0e27d5b5821961297`.
Choose new output paths, since builders refuse to overwrite their outputs.

```sh
export BRIDGE_SIGNING_KEY=/path/to/existing/channel/private.pem
export BRIDGE_PUBLIC_KEY=/path/to/existing/channel/public.pem
export PYTHON_EMBED_ZIP=/path/to/python-3.13.16-embed-amd64.zip
git clone docs/fixtures/bridge-agent-0.1.9-candidate.bundle /tmp/bridge-019-source
git -C /tmp/bridge-019-source checkout --detach 8cc2663a925683f335691a40c5fd0499aaf4be14
cd /tmp/bridge-019-source
sh agent/build_macos_verifier.sh
python3 agent/release.py --output /tmp/bridge-019-macos --version 0.1.9 --signing-key "$BRIDGE_SIGNING_KEY" --public-key "$BRIDGE_PUBLIC_KEY"
python3 agent/build_macos_launcher.py --bootstrap /tmp/bridge-019-macos/bootstrap.pyz --output /tmp/bridge-019-macos/MadhouseWikiBridge.command
python3 agent/windows/build_release.py --output /tmp/bridge-019-windows --version 0.1.9 --private-key "$BRIDGE_SIGNING_KEY" --public-key "$BRIDGE_PUBLIC_KEY" --python-zip "$PYTHON_EMBED_ZIP"
for platform in macos windows; do
  python3 agent/package.py verify --artifact "/tmp/bridge-019-$platform/releases/madhouse-bridge.pyz" --manifest "/tmp/bridge-019-$platform/releases/manifest.json" --signature "/tmp/bridge-019-$platform/releases/manifest.sig" --public-key "$BRIDGE_PUBLIC_KEY" --minimum-version 0.1.9
done
/tmp/bridge-019-macos/MadhouseWikiBridge.command --check
```

Before trusting the output, independently compare the provided public key's DER
SHA-256 with the approved channel fingerprint, and compare it with the key in
existing target bootstraps. The verifier proves the package against the supplied
key; it cannot itself prove that key belongs to the intended channel. The
Windows-specific verifier must also run on the target Windows runtime. Do not
replace the existing Wiki bootstrap hash or Windows archive hash as part of this
handoff; any release configuration change and publication is a separate action.

## Next: isolated macOS fake-install check

On the target Mac, with the signed artifact directory copied intact by an
approved local process, run from the Wiki checkout with Node dependencies. This
uses a fresh temporary directory and local fake game/TLS relay; it never runs the
bootstrap's default download or touches the user's installed bridge:

```sh
export ROOT=/path/to/bridge-channel-0.1.9/macos
export CHECK="$(mktemp -d /tmp/madhouse-signed-019.XXXXXX)"
python3 - <<'PY'
import os, pathlib, sys, zipfile
root = pathlib.Path(os.environ['ROOT'])
check = pathlib.Path(os.environ['CHECK'])
sys.path.insert(0, str(root / 'bootstrap.pyz'))
from bootstrap_config import PUBLIC_KEY
from bootstrap import install_from_fetch
releases = root / 'releases'
installed = install_from_fetch(check / 'releases', PUBLIC_KEY,
                               lambda name, limit: (releases / name).read_bytes())
with zipfile.ZipFile(installed) as archive:
    (check / 'bridge.py').write_bytes(archive.read('bridge.py'))
print('Verified temporary install:', installed)
PY
MADHOUSE_TEST_BRIDGE_AGENT="$CHECK/bridge.py" node --test tests/bridge/tls-websocket-relay.integration.test.mjs
```

Expected: `0.1.9` signature verification and temporary install succeed; all
three fake relay scenarios pass with zero skips, including `python-stop`. This
exercises the installed package's relay through the test-only loader; it does
not launch the actual paired device agent, check macOS Gatekeeper, or prove a
real game outcome. Check the bootstrap key against the trusted fingerprint
before running this procedure. A separate native Windows installation test is
still needed for Windows.

## Installation acceptance, 2026-10-30

| Platform    | Artifact and environment                                                                                                                                                | First launch                                                                                                                                                                                                                                                                                                                                                                                                                    | Fake smoke and update                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Remaining action                                                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| macOS       | Channel-signed `macos/MadhouseWikiBridge.command` on macOS 27.0 arm64                                                                                                   | A byte-identical file fetched over loopback by `curl` ran from a shell with network denied. `spctl --assess --type execute` returned `rejected; source=no usable signature`. After adding a synthetic quarantine attribute on the test copy, `spctl` gave the same result and shell `--check` still passed. Neither shell execution nor a synthetic attribute reproduces Finder's Gatekeeper decision for an ordinary download. | The launcher's actual bootstrap and signed agent were started with isolated `HOME`, a test-only Python hook redirecting the hardcoded release fetch to local signed files and replacing agent execution with `--help`; all network was sandbox-denied. The signed agent was installed to the temporary home. Its extracted relay passed the fake TLS/WebSocket suite 3/3. An isolated local update accepted the actual channel-signed 0.1.8 then 0.1.9 packages. The hook means this is not an unmodified end-to-end installation or paired-agent launch. | Observe a genuine quarantined Finder first-open on an isolated Mac without production access, then complete a fake-connected device test. |
| Windows     | `windows/MadhouseWikiBridge-Windows.zip`, SHA-256 `c827d05306319105c895570dd7cb276fdb09bf67f704655e02e2c4badb10a007`                                                    | A genuine Windows host/VM was not found; no Windows first launch or SmartScreen observation.                                                                                                                                                                                                                                                                                                                                    | Prior Wine checks: Windows verifier accepted 0.1.9 and credential/update fixtures passed 2/2. Wine does not establish Windows acceptance.                                                                                                                                                                                                                                                                                                                                                                                                                 | Use Windows x64 or an x64 Windows VM and a disposable profile; see procedure below.                                                       |
| Linux / iSH | `macos/bootstrap.pyz` is the common Python bootstrap; Wiki's existing install command explicitly targets iPhone/iSH or Android, not a standalone Linux desktop package. | No supported standalone Linux installer was found in this Python bridge delivery. Alpine suite is not an installation test.                                                                                                                                                                                                                                                                                                     | No standalone Linux first-run smoke claimed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Verify the iSH or Android flow on its actual target if it is included in the pilot; do not invent a Linux package.                        |

The `curl` loopback transfer did not add quarantine; the later quarantine was
synthetic and was never removed. The prior Mac may already have system trust
history. No claim is made about a fresh user's Finder dialog. The actual
bootstrap's fixed release URL and the paired agent's fixed game destination
cannot be redirected to fake services through a supported user configuration.
A normal uninstrumented launcher cannot therefore be run online in this test
without risking a real request. The Python test hook was confined to a temporary
folder; it did not change the signed artifact, system security settings, or the
installed user bridge. No real game or production service was contacted.

### Next human action: Finder first-open on an isolated Mac

Use the signed launcher with SHA-256
`b181266997b8c40b924372e15e3e69e3ae340b46de38f5a130441adb7210a796`
and independently check the channel public-key fingerprint from this handoff.
On a disposable Mac profile, disconnect external networking before opening the
file. Acquire the exact file through the ordinary intended download mechanism
only in a separately approved environment; the current local `curl` transfer
is insufficient evidence of download quarantine. Confirm quarantine is present
with `xattr -l`, then attempt the normal Finder open without clearing quarantine
or changing system security settings. Record the exact macOS version, dialog
text and whether it launches. If Finder permits it, keep external networking
disconnected: the bootstrap's production URL will be unreachable, so an install
failure is expected and does not establish fake installation. Return the dialog
and outcome. Do not enter a real invitation or game credential. A real
fake-connected first-run test requires a supported isolated delivery/transport
setup or an explicitly accepted test hook; do not silently substitute either.

### Native Windows handoff (after a Windows environment is available)

Use Windows x64 or an x64 Windows VM with a disposable profile. Check SHA-256 of
`windows/MadhouseWikiBridge-Windows.zip` against the table above before unpacking.
Record download source, Windows version, Mark-of-the-Web and any SmartScreen
warning; do not bypass platform protections automatically. The BAT launcher's
bootstrap uses the fixed production URL, so do not run it with unrestricted
networking during fake acceptance. To exercise the existing no-network Windows
unit/update fixtures, copy the clean bridge source bundle and the separate
`windows-test-fixtures/` directory from the local artifact root. Those fixtures
use a **test key**, not the channel key. In PowerShell, from the extracted
source, with the packaged Python runtime available:

```powershell
$env:MADHOUSE_WINDOWS_TEST_FIXTURES = 'C:\path\to\windows-test-fixtures'
C:\path\to\MadhouseWikiBridge\runtime\python.exe agent\windows\test_runtime.py
```

Expected: 2 tests pass; return their output and the observed first-open warning.
These fixture tests do not by themselves verify a complete normal first install
of the signed 0.1.9 ZIP or authorize sending a game request. Perform that part
only in an isolated fake delivery environment and report it separately.

### Chrome ZIP delivery follow-up

The Wiki macOS download route supplies `MadhouseWikiBridge-macOS.zip`, not a
raw `.command`. A local ZIP was prepared using the existing signed launcher:

```sh
cd /Users/mac/projects/madhouse-wiki/artifacts/bridge-channel-0.1.9/macos
zip -X MadhouseWikiBridge-macOS.zip MadhouseWikiBridge.command
```

The resulting local ZIP has SHA-256
`78579c07362c4b6b305e6ab47adeee1ea82e0a63c3fa5ee6470656834987af48`;
its contained launcher retains SHA-256
`b181266997b8c40b924372e15e3e69e3ae340b46de38f5a130441adb7210a796`.
The ZIP is a local delivery artifact, not an independently signed publisher
signature, and has not been published. The channel signature on the agent and
independently verified channel-key fingerprint remain the trust checks.

Chrome downloaded both variants over local HTTP. The direct `.command` got a
real Chrome quarantine attribute but lost its executable bit (`-rw-r--r--`).
The ZIP download received Chrome quarantine; extracting with `ditto -x -k`
propagated quarantine and restored the launcher's executable bit
(`-rwxr-xr-x`). `spctl --assess --type execute` on the extracted launcher still
reported `rejected; source=no usable signature`. This is a local Chrome and
`ditto` observation, not proof of Finder's first-open UI or a fresh user's
trust history. No quarantine was removed and no security settings were changed.
No launcher was opened via Finder: it would immediately attempt the fixed
production release URL, which is outside this fake-only task.

For the next Finder observation, serve this local ZIP on loopback from the
artifact directory with `python3 -m http.server 43798 --bind 127.0.0.1`,
then download `http://127.0.0.1:43798/MadhouseWikiBridge-macOS.zip` in the
browser of a disposable Mac profile. Check the ZIP hash and quarantine,
extract using the normal macOS UI, and check the launcher's hash, quarantine
and executable bit. Disconnect external networking before opening the launcher
in Finder; localhost delivery does not require an external network. Record the
exact Gatekeeper or Terminal message and whether first-open proceeds. If it
proceeds, failure to fetch the production release while offline is expected;
it is not a successful fake installation. Do not override a system warning or
enter credentials. Stop the temporary local server after the observation.
