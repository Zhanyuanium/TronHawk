# Vendored contract harness

`contract-harness.js` is a byte-identical copy of
`crates/runtime/js/src/contract-harness.js` (the canonical QuickJS
module/lifecycle contract, mirroring the host loader). It ships inside the
`@tronhawk/cli` tarball (`files` covers `src/`) so `tronhawk test --sandbox`
works in tarball installs outside any TronHawk checkout.

Do NOT edit this copy: `src/vendor-sync.test.ts` fails loudly on any byte
drift. Change the canonical source, then re-copy it here verbatim.
