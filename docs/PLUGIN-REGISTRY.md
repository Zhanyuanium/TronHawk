# TronHawk Plugin Registry

Metadata format for **publishing and listing** TronHawk plugins. A future plugin-store UI and the
Manager's catalog browsing are deferred (SPEC §Deferred); this document defines the catalog
**contract** that a future store/Manager will implement. Manager integration — reading a catalog and
cross-checking a downloaded `.thx` against its entry — is future work and is not wired today. This
document only defines the metadata; it never changes the runtime, the SDK, or the `.thx` package
mechanics.

The registry is **metadata-only** (SPEC §6, "Plugin registry — metadata-only (npm-like)"): it indexes
and describes plugins but does **not** host or execute plugin code. A package is downloaded on demand
from `thx.url` as a `.thx` (ZIP), then validated and registered.

## Relationship to the manifest

A registry entry is a **superset** of the plugin's `manifest.json`. The fields that live *inside the
package* — `id`, `name`, `version`, `author`, `tronhawk`, `entry`, `permissions`, `config` — are
carried **verbatim** into the registry entry and **MUST be byte-for-byte identical** to what the
package ships. A validating Manager MUST reject any mismatch to prevent tampering.

Registry-*only* fields (never inside the package manifest):

| Field | Purpose |
|---|---|
| `description` | Listing blurb |
| `tags` | Search / catalogue keywords |
| `homepage`, `source` | Landing page and source repository |
| `apps` | Per-app support matrix (SPEC §5 levels) |
| `thx` | Download URL + integrity digest |
| `risk` | Derived overall risk, computed not declared |

## Catalog file (`registry.json`)

An on-disk catalog is one object; a hosted registry may page/filter it, but this is the canonical
shape:

```json
{
  "schemaVersion": 1,
  "plugins": [
    { "...see Entry schema..." }
  ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `schemaVersion` | integer | ✓ | Catalog format version. `1` is the current version. The Manager ignores or rejects unknown versions. |
| `plugins` | Entry[] | ✓ | Ordered list of entries. |

## Entry schema

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | ✓ | Reverse-DNS, e.g. `com.example.window-effects`. Globally unique in the registry. **MUST equal** the package `manifest.json` `id`. |
| `name` | string | ✓ | Human-readable display name. **MUST equal** the package `name`. |
| `version` | string | ✓ | SemVer (`MAJOR.MINOR.PATCH`). **MUST equal** the package `version`. |
| `author` | string | ✓ | Publisher/author string. **MUST equal** the package `author`. |
| `tronhawk` | string | ✓ | Runtime **protocol** version range the plugin targets (semver range, e.g. `"^0.1"`). This is the host protocol version, **not** the SDK npm version. **MUST equal** the package `tronhawk`. |
| `description` | string | ✓ | 1–3 sentence listing summary. Registry-only. |
| `entry` | object | ✓ | Same shape as the manifest `entry`: `{ "main"?; "renderer"?; "css"? }`. At least one key **MUST** be present. **MUST equal** the package `entry`. |
| `permissions` | string[] | ✓ | Declared permission ids; may be `[]`. **MUST equal** the package `permissions` (treat a missing manifest `permissions` as `[]`). Each id **MUST** be a known permission. |
| `config` | object | ✗ | Per-plugin config schema (`{ key: { type, default, ... } }`). **MUST equal** the package `config` when the plugin declares one; omit otherwise. |
| `tags` | string[] | ✗ | Catalogue keywords. Registry-only. |
| `homepage` | string | ✗ | Project/product URL (http/https). Registry-only. |
| `source` | string | ✗ | Source-code URL for review (http/https). Registry-only. |
| `apps` | AppSupport[] | ✗ | Target-app support matrix. Registry-only. |
| `thx` | object | ✓ (publishable) | `{ "url": string, "sha256": string }` — download URL and SHA-256 digest. Registry-only. A draft entry may omit it, but is not installable. |
| `risk` | string | derived | `low` / `medium` / `high` / `critical`, computed from `permissions`. **Never** declared or manually set. |

### `entry` surface

`entry` mirrors the manifest type-for-type and is intentionally opaque to the registry — the Manager
does **not** extract or read the referenced file. At least one of `main` (Electron main process),
`renderer` (Chromium renderer), or `css` (declared CSS-as-data theme) must be present.

> In the workspace examples the entry path is the source file (e.g. `src/main.ts`) because there is no
> build step yet; in a published `.thx` the path is whatever the package ships (typically compiled JS).

### `config` surface

Like the manifest, `config` declares a per-plugin schema; the Manager auto-generates a settings UI.
It is optional and must match the package manifest exactly. Example (entry + matching manifest):

```json
{
  "entry": { "main": "main.ts" },
  "config": { "opacity": { "type": "number", "default": 0.9 } }
}
```

The registry entry's `config` object and the package's `manifest.json` `config` object are identical
(the registry does not invent or override it).

### `permissions` and derived `risk`

`risk` is computed as the **highest** risk among the declared permissions (the mapping below matches
the authoritative risk table used by the Manager's permission review). An empty `permissions` array
is `low`.

| Permission | Risk |
|---|---|
| `renderer.css` | low |
| `renderer.script` | medium |
| `renderer.dom` | medium |
| `electron.window` | high |
| `electron.webContents` | medium |
| `electron.session` | medium |
| `electron.ipc` | high |
| `network.access` | medium |
| `network.proxy` | high |
| `runtime.unsafe` | critical (dev only) |

### App support matrix (`apps[]`)

Each element describes one target app using the tiered support levels from SPEC §5.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | ✓ | App identifier (e.g. `com.openai.chat`), matched against the Manager's app DB. |
| `exe` | string | ✗ (recommended) | Executable stem used for auto-detection (e.g. `ChatGPT`, `Code`, `Discord`). |
| `supportLevel` | number | ✓ | `0` = unsupported, `1` = renderer extension only, `2` = Electron extension. |

`supportLevel` explicitly describes the **target app**, not the plugin. A plugin may be listed with
`supportLevel: 2` for one app and `1` for another; the Manager displays this so a user knows what to
expect on each app.

## Concrete example

Two entries, matching the workspace example plugins `window-effects` (main) and `ui-tweaks`
(renderer + CSS). `sha256` digits are illustrative.

```json
{
  "schemaVersion": 1,
  "plugins": [
    {
      "id": "com.example.window-effects",
      "name": "Window Effects",
      "version": "0.1.0",
      "author": "Example",
      "tronhawk": "^0.1",
      "description": "Softens each new window to 90% opacity as the host creates it.",
      "entry": { "main": "src/main.ts" },
      "permissions": ["electron.window"],
      "tags": ["windows", "opacity", "effect"],
      "homepage": "https://example.tronhawk.dev/window-effects",
      "source": "https://github.com/example/window-effects",
      "apps": [
        { "id": "com.openai.chat", "exe": "ChatGPT", "supportLevel": 2 },
        { "id": "md.obsidian", "exe": "Obsidian", "supportLevel": 2 }
      ],
      "thx": {
        "url": "https://registry.tronhawk.dev/plugins/com.example.window-effects/window-effects-0.1.0.thx",
        "sha256": "5d6f7a9c0b1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a"
      }
    },
    {
      "id": "com.example.ui-tweaks",
      "name": "UI Tweaks",
      "version": "0.1.0",
      "author": "Example",
      "tronhawk": "^0.1",
      "description": "Recolors the page selection highlight and renames the window title.",
      "entry": { "css": "style.css", "renderer": "src/renderer.ts" },
      "permissions": ["renderer.css", "renderer.script"],
      "tags": ["renderer", "css", "title"],
      "apps": [
        { "id": "md.obsidian", "exe": "Obsidian", "supportLevel": 1 }
      ],
      "thx": {
        "url": "https://registry.tronhawk.dev/plugins/com.example.ui-tweaks/ui-tweaks-0.1.0.thx",
        "sha256": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2"
      }
    }
  ]
}
```

Note the derived `risk` values: `window-effects` → `high` (`electron.window`); `ui-tweaks` → `medium`
(`renderer.script` is the highest of `renderer.css` + `renderer.script`). Neither is written into
the JSON.

## How a future Manager should validate it

This is the **planned** validation contract for when catalog browsing and install-time integrity
land in the Manager — it is not implemented today. It is specified so a future implementation and a
catalog publisher agree on the exact rules.

The Manager should validate **twice**: at listing time (index browse) and again at install time
(after the `.thx` is downloaded).

**Listing-time (reads the catalog):**

1. **Schema** — `schemaVersion` is supported; every required field is present with the correct JSON
   type. Unknown extra fields are ignored with a warning (forward compatibility); unexpected *values*
   for known fields are rejected.
2. **Enums** — `supportLevel ∈ {0,1,2}`; every `permissions[]` entry is a known permission id; `entry`
   has at least one known key; `tronhawk` is a valid semver range.
3. **Id / version** — `id` is reverse-DNS and unique in this catalog; `version` parses as SemVer.
4. **URLs** — `thx.url`, `homepage`, `source` are well-formed `http(s)` URLs; `thx.sha256` is 64 hex
   chars.
5. **Risk** — derive `risk` from `permissions` (the declared value is never trusted) and cluster by
   risk for the permissions banner.
6. **Runtime compat** — the host's runtime protocol version satisfies `tronhawk`; otherwise the entry
   is hidden/dimmed with a reason. The `apps` matrix is attached for the UI.

**Install-time (after fetching `thx.url`):**

7. **Integrity** — verify the downloaded bytes against `thx.sha256`; reject on mismatch.
8. **Manifest consistency** — unpack the `.thx`, read its `manifest.json`, and compare `id`, `name`,
   `version`, `author`, `tronhawk`, `entry`, `permissions`, `config` to the registry entry. **Any**
   difference is a tamper rejection (install aborted). Then follow the normal install flow
   (receive → validate manifest → check permissions → extract → register).
9. **Permission policy** — block unknown permission ids; `runtime.unsafe` is refused unless developer
   mode is on AND the user explicitly approves the grant.
10. **Version gate** — apply the repo SemVer convention (major = breaking) to warn the user before an
    install that changes behavior; a downgrade or identical `id`+`version` re-listing is rejected.

## Versioning & id rules

- `id` is reverse-DNS `com.<publisher>.<plugin>` and globally unique; it binds the entry to a
  publisher for trust and provenance.
- `version` is SemVer; a new package version is a **new** registry entry (`id`+`version`). An entry is
  immutable once published — corrections ship as a new version, never a rewrite.
- `tronhawk` is a semver **range** that the host runtime's protocol version must satisfy; it is not
  tied to the SDK npm version (see `PLUGIN-SDK.md`).

## Publishing (brief)

A publisher adds an entry to the catalog and uploads the `.thx` to `thx.url`. Content is published by
a registrar (future), but the format is fixed: metadata is always separate from code, and the Manager
never executes registry content — it only ever validates the downloaded `.thx` against the metadata
and then registers the package.
