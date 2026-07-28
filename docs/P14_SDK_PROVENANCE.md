# P14 wallet SDK provenance

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
