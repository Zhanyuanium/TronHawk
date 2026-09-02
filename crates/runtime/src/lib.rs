//! Execute plugins, provide APIs, bridge to Electron. Must NOT do user/install management.
//!
//! The Runtime is implemented in JS: `crates/runtime/js/src/index.js`, bundled to
//! `assets/runtime.js`, loaded by the injector's bootstrap into the target's main process.
//! It embeds a QuickJS sandbox (docs/adr/0002-renderer-js-sandbox.md) for untrusted plugin
//! JS. This Rust crate is a placeholder holding only the runtime's contract in `assets/`;
//! it does not host a native bridge. See docs/AGENTS.md for the Runtime layer ownership.

#[cfg(test)]
mod tests {
    #[test]
    fn placeholder_compiles() {
        assert_eq!(2 + 2, 4);
    }
}
