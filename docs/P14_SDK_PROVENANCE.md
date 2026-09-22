# Wallet SDK provenance

## Current local QA candidate — 2026-09-22

- SDK: `@embercover/wallet-sdk@1.3.2-beta.3`
- Artifact: `vendor/embercover-wallet-sdk-1.3.2-beta.3.tgz`
- SHA-256: `2f344615b3f9b00726845cd321a0bc82ac5bda968fef24147268750d4c539b27`
- Backend contract commit: `418bc944c60ec317e5e48eb826061b5f3e3affa8`
- Contract SHA-256: `6625f15fe48c417831c0c09d7500662cbec5b29f4afc73f49374b3effc7ab77f`
- Isolated build: `.output/qa-candidate/chrome-mv3`

SDK provenance/generated-contract and release-channel checks passed. The wallet
installs the exact vendored beta.3 package; QA verification checks installed
version, dependency, lockfile, hash, environment and Chrome identity.

The hosted Devnet API was inspected on 22 September and still lacks all three
new contract elements: current coverage, cancellation, and allowance. Do not
replace the currently installed extension until the backend cutover is complete.
The original `.output/chrome-mv3` and beta.2 vendor artifact were preserved.

269 wallet tests and one additional signer-failure cleanup check passed. All 12 Chromium journeys passed across the initial run
(11 passed) and a targeted rerun of active/inactive coverage after correcting a
wallet-ownership bug in the isolated API fixture. Typechecking and the isolated
QA build/verifier passed. No live wallet transaction, deployment, push or SDK
publication was performed. See [R01 checkpoint](R01_03_MANUAL_QA.md).

## Historical beta.2 Devnet QA binding — 2026-09-22

- Package: `@embercover/wallet-sdk`
- Version: `1.3.2-beta.2`
- Vendored file: `vendor/embercover-wallet-sdk-1.3.2-beta.2.tgz`
- SHA-256: `89b7b1f2e8d5e1a4e7ba7f5eee5bc9d5374eed825339990cd00d84d1ae27fbff`
- Source worktree: sibling `wallet-sdk` repository on
  `codex/r01-approval-reliability`

The Devnet QA wallet installs this reviewed local tarball instead of resolving
an npm tag or version range. This binds the wallet to the exact beta.2 candidate
and prevents a registry update from changing an already-reviewed artifact.

The packaged manifest identifies `@embercover/wallet-sdk@1.3.2-beta.2`. The
currently installed package's manifest and representative runtime, CommonJS,
declaration, and contract-provenance files are byte-identical to the vendored
tarball. `scripts/verify-qa-build.ts` checks the dependency specifier, lockfile
entry, installed package version, and tarball SHA-256 before accepting a QA
release build.

Verification resumed later on 2026-09-22 at product direction: typechecking,
245 unit tests, QA build/artifact verifier and 12 packaged Chromium journeys
passed. See [the verification record](R01_01_VERIFICATION.md) for the open
single-use review finding and pending Manual QA; these results do not certify R01.
Publication and release-tag movement remain separate actions.

## Historical P14 binding

- Package: `@embercover/wallet-sdk`
- Version: `1.1.1`
- Source worktree: Ember API P13 baseline plus the P14 exact-origin and
  browser-fetch corrections
- Vendored file: `vendor/embercover-wallet-sdk-1.1.1.tgz`
- SHA-256: `0348fe7456eca64c1c651b6be49b1fb8b59e21e7615430011a0adcf57e97f985`

The source package was installed with its locked dependencies, built, scanned,
and packed twice. Both tarballs were byte-identical. Version 1.1.1 includes the
Chrome/Worker platform-fetch receiver correction found by the P14 browser
conformance run. The package contains ESM, CommonJS, declarations, source maps,
README, licence, and package metadata. It contains no partner credential or
legacy wallet credential transport.

The wallet uses a local tarball so a registry update cannot silently replace
the reviewed package. `scripts/verify-p14-build.ts` fails if the tarball digest
changes.
