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

For a small manual update:

1. Edit or add one provider fragment under `providers/`.
2. Keep `catalog/manifest.json` updated when the catalog timestamp or curated provider order changes.
3. Run `npm run build`.
4. Commit both the provider fragment and the generated `catalog/model-provider-catalog.json`.

For an upstream-assisted update:

1. Add or adjust source metadata in `sources/upstreams.json`.
2. Add explicit model/gateway sync rules in `sources/model-sync.json`.
3. Run `npm run sync:upstreams`.
4. Run `npm run build`.
5. Run `npm run check`.
6. Review the provider fragment diff before committing.

`npm run sync:upstreams` is intentionally conservative. It uses machine-readable upstream sources to fill model metadata and curated sync rules to add known models or gateway presets. It does not blindly replace whole provider files, and it does not remove models. This keeps official-account login behavior and user-created gateway choices stable.

CI or maintainers can run `npm run check` to verify the generated aggregate is current.

## Automatic Upstream Sync

`.github/workflows/sync-upstream-models.yml` runs every 12 hours and can also be triggered manually from GitHub Actions.

The workflow:

1. Checks out the catalog repository.
2. Runs `npm run sync:upstreams`.
3. Runs `npm run build`.
4. Runs `npm run check`.
5. If files changed, pushes `chore/sync-upstream-model-catalog` and opens or updates a pull request.

The action should be reviewed before merge because provider docs can disagree with aggregators, especially for new releases, regional restrictions, preview models, and model shutdown dates.

## Upstream Sources

Machine-readable sources are configured in `sources/upstreams.json`:

- LiteLLM model catalog: `https://api.litellm.ai/model_catalog`
- OpenRouter models API: `https://openrouter.ai/api/v1/models`
- Vercel AI Gateway models endpoint: `https://ai-gateway.vercel.sh/v1/models`

Official documentation sources are also recorded in `sources/upstreams.json` so a future maintainer can verify curated overrides quickly. Current official-doc references include OpenAI, Anthropic, DeepSeek, Z.AI/GLM, Gemini, Qwen/DashScope, MiniMax, Moonshot/Kimi, and Cloudflare Workers AI.

When a new model appears in official docs before every aggregator catches up, add it to `sources/model-sync.json` with explicit `contextWindow`, `maxTokens`, lifecycle fields, and `source`. GLM-5.2 is handled this way: Z.AI official docs define the 1M context and 128K max output, while OpenRouter and Vercel provide machine-readable confirmation.

## Catalog Contract

- `schemaVersion`: integer catalog schema version.
- `updatedAt`: ISO timestamp for cache/debug visibility.
- `providers`: provider templates used by the chat settings page and Agent gateway settings.
- `models`: chat model presets for a provider.
- `agentGateways`: target-specific templates for `claude_code`, `codex`, `opencode`, and `copilot`.
- `status`, `shutdownDate`, `fallbackModelId`, and `disabledByDefault`: lifecycle metadata used by HaloForge to avoid enabling unavailable models by default and to guide users toward fallbacks.

Gateway templates are presets only. HaloForge applies them to runtime agents only after a user explicitly adds or edits an Agent gateway config in the desktop app.
