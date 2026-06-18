# HaloForge AI Provider Catalog

Public model provider presets for HaloForge chat and Agent gateway configuration.

The generated catalog file consumed by HaloForge is:

- `catalog/model-provider-catalog.json`

Human-edited provider templates live under:

- `providers/official/*.json`
- `providers/third-party/*.json`
- `providers/aggregator/*.json`
- `providers/local/*.json`
- `providers/custom/*.json`

HaloForge Community Cloud proxies this file through:

- `https://api.haloforge.dev/v1/ai/model-provider-catalog`
- `https://haloforge.dev/api/ai/model-provider-catalog.json`

Use this repository for lightweight template updates when a provider ships a new model or a new Agent gateway preset. The desktop app should not need a full release for ordinary catalog changes.

## Update Flow

1. Edit or add one provider fragment under `providers/`.
2. Keep `catalog/manifest.json` updated when the catalog timestamp or curated provider order changes.
3. Run `npm run build`.
4. Commit both the provider fragment and the generated `catalog/model-provider-catalog.json`.

CI or maintainers can run `npm run check` to verify the generated aggregate is current.

## Catalog Contract

- `schemaVersion`: integer catalog schema version.
- `updatedAt`: ISO timestamp for cache/debug visibility.
- `providers`: provider templates used by the chat settings page and Agent gateway settings.
- `models`: chat model presets for a provider.
- `agentGateways`: target-specific templates for `claude_code`, `codex`, `opencode`, and `copilot`.

Gateway templates are presets only. HaloForge applies them to runtime agents only after a user explicitly adds or edits an Agent gateway config in the desktop app.
