# Bridge package handoff

The pinned compatible relay is `9db18cede7ecc0a0ca1499d854fe5319a7a44bef`: it advertises connection-bound stop acknowledgement and sends it only after the associated relay worker has stopped. Old clients remain usable for ordinary transport but cannot provide this proof. Neither proof nor stopping a device establishes whether the game processed bytes already received; an uncertain mutation remains fenced.

A **test-key-only macOS assembly**, not a production installer, was built at `/tmp/bridge-macos-relay-9db18ce-second/`. It contains `bootstrap.pyz`, `releases/madhouse-bridge.pyz`, signed test manifest, signature, `release-info.json` and `MadhouseWikiBridge.command`. Its version is synthetic `0.0.1`; the launcher `--check`, agent `--help`, Python manifest verification and CryptoKit verifier passed. Two builds with identical test inputs produced identical outputs. The installed device was not modified and no pairing or game connection was attempted.

The relay came from the pinned commit, but the Mac packaging scripts and credential store came from the user's separate, uncommitted bridge checkout. Therefore the assembly is not reproducible from `9db18ce` alone and must not be published as a release. Before a production package can be prepared, the bridge owner must establish a reviewed, committed source revision containing the complete platform packaging chain and select a release version. Then build using that revision's `agent/release.py` and `agent/build_macos_launcher.py`, use the approved signing process without sharing private keys, verify the embedded public key, contents, hashes and launch on the target platform, and perform any required Developer ID signing/notarization. Verify the installed version using the commands in that exact release; the above test version does not describe a user's installation.

The pinned commit's Windows builder `agent/windows/build_release.py` additionally requires the official Python 3.13.16 embeddable ZIP with the SHA-256 specified in its source, release signing keys and a Windows runtime for a native smoke test. Windows packaging and device installation were not completed. A zipapp assembled from relay sources without the platform files is not a valid substitute.

The already-built test package can be checked locally without installation:

```sh
/tmp/bridge-macos-relay-9db18ce-second/MadhouseWikiBridge.command --check
python3 /tmp/bridge-macos-relay-9db18ce-second/releases/madhouse-bridge.pyz --help
python3 /tmp/bridge-macos-relay-9db18ce-src/agent/package.py verify \
  --artifact /tmp/bridge-macos-relay-9db18ce-second/releases/madhouse-bridge.pyz \
  --manifest /tmp/bridge-macos-relay-9db18ce-second/releases/manifest.json \
  --signature /tmp/bridge-macos-relay-9db18ce-second/releases/manifest.sig \
  --public-key /tmp/bridge-macos-relay-9db18ce-test-public.pem \
  --minimum-version 0.0.1
```

The exact test assembly command, after preparing its mixed-provenance source directory and its disposable Ed25519 key, was:

```sh
python3 /tmp/bridge-macos-relay-9db18ce-src/agent/release.py \
  --output /tmp/bridge-macos-relay-9db18ce-second --version 0.0.1 \
  --signing-key /tmp/bridge-macos-relay-9db18ce-test-private.pem \
  --public-key /tmp/bridge-macos-relay-9db18ce-test-public.pem
python3 /tmp/bridge-macos-relay-9db18ce-src/agent/build_macos_launcher.py \
  --bootstrap /tmp/bridge-macos-relay-9db18ce-second/bootstrap.pyz \
  --output /tmp/bridge-macos-relay-9db18ce-second/MadhouseWikiBridge.command
```

The temporary source directory includes uncommitted Mac support files. It is retained solely as evidence, not as an approved release source. The test private key is disposable and must never be used for release signing. Rebuilding a release or writing an installation/version-check instruction requires the reviewed committed platform source and chosen release version first.
