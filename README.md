# HaloForge AI Provider Catalog

Public model provider presets for HaloForge chat and Agent gateway configuration.

The canonical catalog file is:

- `catalog/model-provider-catalog.json`

HaloForge Community Cloud proxies this file through:

- `https://api.haloforge.dev/v1/ai/model-provider-catalog`
- `https://haloforge.dev/api/ai/model-provider-catalog.json`

Use this repository for lightweight template updates when a provider ships a new model or a new Agent gateway preset. The desktop app should not need a full release for ordinary catalog changes.

## Catalog Contract

- `schemaVersion`: integer catalog schema version.
- `updatedAt`: ISO timestamp for cache/debug visibility.
- `providers`: provider templates used by the chat settings page and Agent gateway settings.
- `models`: chat model presets for a provider.
- `agentGateways`: target-specific templates for `claude_code`, `codex`, `opencode`, and `copilot`.

Gateway templates are presets only. HaloForge applies them to runtime agents only after a user explicitly adds or edits an Agent gateway config in the desktop app.
