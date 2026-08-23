//! TronHawk injector — wraps `electron-hook` to inject into target Electron apps.
//!
//! Re-exporting `electron_hook::*` compiles electron-hook's `DllMain` hook into this
//! cdylib, so the built `.dll` performs the Detours injection + in-memory ASAR remap.
//!
//! This layer must NOT contain plugin logic or permission decisions (see docs/AGENTS.md).

pub use electron_hook::*;
