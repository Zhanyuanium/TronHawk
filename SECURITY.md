# Security Policy

TronHawk is a runtime extension platform: it loads **untrusted third-party
plugins** into third-party Electron applications. Security is therefore the
product's core design constraint, not an add-on. This page states the threat
model, the boundaries of the supported configuration, and how to report a
vulnerability.

## Threat model

The primary adversary is a **malicious or compromised plugin**. TronHawk must
ensure that a plugin can only exercise the capabilities its author declared
and the user granted, and that it cannot reach the host OS, the network, the
target app's other data, or arbitrary page JavaScript on its own.

Out of scope by design (see `docs/SPEC.md` §3 non-goals): bypassing DRM,
anti-cheat, banking, or enterprise security, and supporting apps that actively
resist extension. TronHawk never modifies the target app on disk.

## Security model

Defense in depth, top to bottom:

- **Sandboxed execution.** Renderer and main plugin code runs in an embedded
  QuickJS engine (`docs/adr/0002-renderer-js-sandbox.md`). The context has no
  `document`, `fetch`, `require`, or `process` by default — no raw DOM, network,
  Node, or Electron access.
- **No arbitrary page JS.** CSS is data-only, injected via
  `webContents.insertCSS` and never evaluated. Renderer script is restricted to
  narrow host-owned operations; `setDocumentTitle`, for example, is performed
  with a host-owned fixed assignment template where plugin input is inserted
  only after JSON serialization — it can never become executable source.
- **Permission gate.** Every privileged API checks the plugin's declared
  permissions (`docs/PLUGIN-SDK.md`). Nothing is reachable without the matching
  grant; `runtime.unsafe` (raw Electron/Node, developer mode) is off by default
  and currently unreachable in practice.
- **CPU and memory bounds.** Every evaluation and host-invoked callback runs
  under a one-second CPU deadline with memory and stack limits. Plugins that
  exceed a cumulative interrupt budget are hard-disabled for the current plan
  generation (fail closed).
- **Safe install and packages.** Installing never executes package code:
  `manifest.json` is validated, `.thx` extraction is zip-slip-guarded and
  archive-limited. The registry format (`docs/PLUGIN-REGISTRY.md`) defines a
  planned install-time integrity cross-check (downloaded-package bytes vs. entry
  metadata, tamper rejection); that cross-check is a contract, not yet wired
  into the Manager.
- **Authenticated control plane.** Core↔target IPC is versioned JSON-RPC over a
  local socket protected by a control token and HMAC-signed, expiring launch
  tokens; plugin activity is attributed and recorded in Core-owned log
  streams.

## Supported-app boundary

Security properties are claimed only for the **supported configuration**:

- **Level 0 (unsupported)** — hardened targets, ASAR-integrity-checking apps,
  and DRM/anti-cheat/banking/enterprise software are **not supported** and may
  detect, resist, or behave unpredictably under injection. Do not use TronHawk
  against them; no security or reliability guarantees apply.
- **Level 1 (renderer extension)** and **Level 2 (Electron extension)** — the
  tiers where the sandbox, permission gate, and runtime-only invariants are
  designed to hold. Compatibility is validated per app; see `docs/SPEC.md` §5
  and the real-target findings in `docs/BACKLOG.md`.

Even at a supported level, the extension layer protects the *system and the
user's other apps* from a plugin; a plugin the user deliberately grants
`electron.window` can still restyle or resize windows of the app it targets. A
plugin with granted high-risk permissions (`electron.ipc`, `network.proxy`,
`runtime.unsafe`) is equivalent to granting that software elevated reach —
review permission prompts accordingly.

## Reporting a vulnerability

Please report security issues **privately**, not as a public issue, so the
maintainers can ship a fix before details are public:

1. Use the repository's private reporting channel — on GitHub, the **Security →
   Report a vulnerability** flow, if enabled on the repository.
2. If that is unavailable, open a **private** report by contacting the
   maintainers directly (see the repository's commit/author metadata) and mark
   the subject `[SECURITY]`.
3. Include: a description of the issue, the affected version/commit, the
   target-app tier and Electron version involved (if relevant), and a minimal
   reproduction (a `.thx` plugin or manifest that demonstrates it, when
   possible).

What happens next:

- The maintainers will acknowledge receipt, triage, and coordinate a fix and a
  private disclosure. Fixes land through the normal review flow
  (`CONTRIBUTING.md`), are covered by tests where practical, and are documented
  in commit messages and release notes without exposing the exploit details
  before the fix ships.
- Treat this project as pre-release (`0.1`): there is no standing security
  support window yet. Responsible disclosure and a clear reproduction are the
  most effective ways to get a fix prioritized.

## Deployment guidance

- Only register apps you own or are permitted to extend, and only at their
  validated support level.
- Enable plugins from sources you trust; review the permission prompt before
  granting, and treat high-risk grants like installing the equivalent software.
- Keep `developerMode` / `runtime.unsafe` off (it is off by default).
