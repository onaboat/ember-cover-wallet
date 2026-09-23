# R01 final automated test pass — 22 September 2026

Requested full verification after the repair implementation. No product source changes were required during this pass. The baseline demo, pinned SDK artifacts, installed Chrome build, deployments and user databases were not changed. Nothing was committed, pushed or published.

| Area | Result |
| --- | --- |
| Wallet unit suite | 278 passed / 48 files |
| Packaged Chromium wallet journeys | 12 passed |
| Standalone SDK unit suite | 215 passed / 12 files |
| Backend embedded SDK unit suite | 33 passed / 4 files |
| Rust workspace, all targets/features | 654 passed, 2 intentionally ignored |
| API + Agave 3.1.12 local-validator integration | 5 passed |
| Fresh PostgreSQL migration ledger | 24 of 24 successful |

Additional successful checks:

- Wallet TypeScript, conformance-fixture build, QA candidate build and strict artifact verifier. Candidate files match R01_05_BUILD_MANIFEST.json exactly.
- Complete standalone SDK `npm run verify`: contract provenance/generated wire code, release policy, types/examples, packed ESM/CommonJS consumers, exact browser origins/MV3 worker, Metro Android/Hermes native execution and two-process session restoration, public boundary, secret scan and package allowlist.
- Backend embedded SDK generated wallet and partner contracts, types/examples, packed consumers, bundle secret scan, private-release guard, SBOM and package dry run.
- Rust formatting, strict workspace Clippy, OpenAPI generation drift, and the optimized `cargo build --release --locked -p ember-api` build.

The embedded SDK's first packed-consumer attempt was blocked by the sandbox's npm-cache permissions. It passed after rerunning with the required access; no code change was needed.

The two Rust ignores are explicitly configured external preflights: live Devnet runtime evidence and Surfpool mainnet-state replay. They were not silently counted as passes. The older-database upgrade/reproducibility CI jobs and npm registry vulnerability audit were not run in this local pass.

Local toolchain: Bun 1.3.14, Rust 1.94.1, Node 25.8.1, PostgreSQL 16, Agave 3.1.12. Remote CI uses Linux and Node 22 for the embedded SDK / Node 24 for the standalone SDK; this report is local evidence, not a remote CI result.

The disposable database container was removed. The API and validator used temporary local test state. No live Devnet transaction was signed or broadcast.

Live QA and the total-storage-failure/service-worker-shutdown boundary documented in R01_05_REPAIR_CHECKPOINT.md remain open. Passing these tests does not demonstrate that boundary or certify absence of all defects.

Logs from this run:

- /private/tmp/ember-r01-wallet-final-e2e.log
- /private/tmp/ember-r01-wallet-final-build.log
- /private/tmp/ember-r01-sdk-final-verify.log
- /private/tmp/ember-r01-backend-final-tests.log
- /private/tmp/ember-r01-backend-final-e2e.log
- /private/tmp/ember-r01-backend-final-release.log
