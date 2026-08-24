//! Execute plugins, provide APIs, bridge to Electron. Must NOT do user/install management.
//!
//! The main-process JS side of the Runtime lives in `assets/runtime.js` (loaded by the
//! injector's bootstrap into the target). This Rust crate will host the native-side bridge
//! (a QuickJS sandbox, per docs/adr/0002-renderer-js-sandbox.md) in Phase 3.

#[cfg(test)]
mod tests {
    #[test]
    fn placeholder_compiles() {
        assert_eq!(2 + 2, 4);
    }
}
