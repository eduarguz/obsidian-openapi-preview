# OpenAPI Preview

Browse OpenAPI 3.0 and 3.1 YAML/JSON specifications in a dedicated Obsidian tab,
using the free, open-source Redoc Community Edition renderer.

## Features

- Automatically recognize `.yaml`, `.yml`, and `.json` in the file explorer while the plugin is enabled.
- Click an OpenAPI document to render it; schema fragments and other files display read-only source.
- Open a specification through the command palette or a file's context menu.
- Resolve local `$ref` files relative to each referencing file, anywhere inside the vault.
- Mix YAML and JSON dependencies, including JSON Pointer fragments, named schema anchors, and recursive schemas.
- Automatically refresh when the specification or a referenced file changes.
- Recover automatically when a previously missing referenced file is created.
- Follow Obsidian's light/dark theme; keep renderer styling isolated in its own frame.
- Render locally using bundled JavaScript, fonts from the system, and a bundled attribution logo.

This is a documentation viewer, without an API request console. It checks the OpenAPI
version and required `info` fields, but is not a full OpenAPI validator. Remote HTTP
references, absolute filesystem paths, Obsidian wikilinks, and files outside the vault
are not supported. Use standard relative paths such as `./schemas/user.yaml` and
`../shared/errors.json#/NotFound`.

The renderer itself needs no network access. Images or links explicitly included in
your specification's descriptions remain normal external images or links.

## Load the plugin in this development vault

This repository is already located at:

```text
.obsidian/plugins/openapi-preview/
```

1. Install dependencies and build:
   ```sh
   npm install --include=dev
   npm run build
   ```
2. Reload Obsidian so it discovers `manifest.json` and `main.js`.
3. Enable **OpenAPI Preview** under **Settings → Community plugins**.
4. Click the main YAML/JSON specification in the file explorer to open its preview.
   You can also run **OpenAPI Preview: Choose OpenAPI file** from the command palette.
5. Clicking a schema fragment or another YAML/JSON file shows its literal, read-only source.

**Open OpenAPI preview** previews the active YAML/JSON file, or opens the picker when
the active file is another type. You can also right-click a YAML/JSON file in the
file explorer and select **Open OpenAPI preview**.

The plugin registers each supported extension individually through Obsidian's API;
it does not change the vault-wide visibility setting. If another plugin already
handles an extension, that handler is preserved, a notice is shown, and OpenAPI
Preview's commands and context-menu action remain available. **Settings → Files and
links → Show all file types** (called **Detect all file extensions** in some versions)
is an optional fallback for visibility. Extension registrations are removed by
Obsidian when this plugin unloads.

Read-only source refreshes when its file changes. If the file becomes an OpenAPI
document, the tab automatically switches to rendered documentation; removing its
top-level `openapi` field switches it back. Malformed files show their source with
a parsing diagnostic. Documents declaring `openapi` still show preview errors for
unsupported versions, missing required fields, and unresolved references.

The refresh icon in the preview tab, or **Refresh OpenAPI preview** in the command
palette, rebuilds the documentation manually. Open views retain their file state
through Obsidian's workspace persistence.

## Try the example

Copy the `examples/` folder into a visible folder in your vault, outside `.obsidian/`.
Open `examples/openapi.yaml` with the preview command. It references a path file,
which in turn references a schema in a sibling folder:

```text
examples/
  openapi.yaml
  paths/users.yaml
  schemas/user.yaml
```

Modify the operation summary in `paths/users.yaml` to see automatic refresh.
Nothing is written back to the specification: reference bundling happens in memory.

## Development

The TypeScript/esbuild setup follows the official
[Obsidian sample plugin](https://github.com/obsidianmd/obsidian-sample-plugin).

```sh
npm run dev          # Watch and rebuild main.js
npm run check        # TypeScript checks
npm test             # Vault reference resolver tests
npx playwright install chromium --only-shell
npm run test:browser # Real Chromium renderer and refresh tests
npm run build        # Type-check and generate the production bundle and notices
```

Reload the plugin after changing its source. `main.js` is generated and git-ignored.
For a manual installation in another vault, copy `main.js`, `manifest.json`,
`styles.css`, and `THIRD_PARTY_NOTICES.md` into its
`.obsidian/plugins/openapi-preview/` directory.

### Source map

- `src/main.ts`: commands, file picker, context menu, and tab activation.
- `src/view.ts`: file-aware preview, dependency events, refresh, and cleanup.
- `src/bundle.ts`: vault-only reference resolver and in-memory bundling.
- `src/prepare.ts`: OpenAPI schema siblings, literal example data, and named anchors.
- `src/renderer.ts`: isolated Redoc frame and theme integration.
- `esbuild.config.mjs`: bundles Redoc's standalone distribution and browser Buffer shim.

Browser tests run the real bundled renderer and view with a small Obsidian host
adapter. They cover multi-file documentation, offline assets, dark/narrow layouts,
cancellation, dependency refresh, and recovery from missing files. The host adapter
also covers extension registration, existing-handler conflicts, literal source views,
and transitions between source and documentation. It does not replace an in-app
check of Obsidian's file explorer, command palette, and workspace behavior.

## License

MIT. Third-party license notices are generated from the installed dependencies during
the production build into `THIRD_PARTY_NOTICES.md`. Redoc's attribution is retained,
with its logo bundled locally.
