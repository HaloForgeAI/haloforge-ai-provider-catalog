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

`.github/workflows/sync-upstream-models.yml` runs every 6 hours and can also be triggered manually from GitHub Actions.

The workflow:

1. Checks out the catalog repository.
2. Runs `npm run sync:upstreams`.
3. Runs `npm run build`.
4. Runs `npm run check`.
5. If files changed, classifies the semantic catalog diff, pushes `chore/sync-upstream-model-catalog`, and opens or updates a pull request.
6. Only upstream-owned metadata refreshes to existing models are eligible for squash auto-merge after verification. Every newly discovered model, provider metadata change, Agent gateway change, lifecycle/fallback change, removal, restricted model, and preview model remains queued for human review.

If organization policy prevents `GITHUB_TOKEN` from creating pull requests, add a repository secret named `HF_PROVIDER_CATALOG_SYNC_TOKEN`. Use a fine-grained personal access token or GitHub App token scoped to this repository with `Contents: Read and write` and `Pull requests: Read and write`. Without that secret, the workflow still pushes the sync branch and prints a manual PR link.

The action should be reviewed before merge because provider docs can disagree with aggregators, especially for new releases, regional restrictions, preview models, and model shutdown dates.

### Source Authority

The catalog uses a hybrid sync model. No upstream is authoritative for every field:

- Official provider model-list APIs establish account-visible model ids and update only fields actually returned by that API. Their responses can be account- and region-specific, so a missing id never removes a catalog model.
- Official model, pricing, changelog, and lifecycle documentation is preferred for public availability, context/output limits, preview/deprecation state, and replacement guidance.
- `models.dev/api.json` is a provider-offering candidate source. It is used instead of provider-agnostic `models.dev/models.json` so an underlying model is not confused with a model actually served by a specific provider.
- LiteLLM, OpenRouter, and Vercel AI Gateway are cross-check and gap-filling sources. They never change provider ownership or replace a reviewed official lifecycle value.
- Automated discovery never creates Agent gateway presets. Gateway endpoint compatibility, role mappings, generation options, and CLI behavior require explicit documentation and human review.

Provider `category` describes who serves the configured API endpoint. DeepSeek, Moonshot, MiniMax, Alibaba Cloud/Qwen, Z.AI, xAI, Mistral, and Perplexity are `official` because these entries point to their own first-party APIs. OpenRouter remains an `aggregator`; Ollama remains `local`; user-supplied endpoints remain `custom`.

Every non-local model and Agent gateway must reference an id registered in `sources/upstreams.json`. `npm run build` fails on missing or unknown source ids, which keeps provenance visible in the generated catalog.

Official provider model-list APIs are authenticated and optional. When a provider key is configured, a failure from that official source fails the workflow instead of silently trusting stale data. Without a provider key, the reviewed snapshot and required LiteLLM/OpenRouter/Vercel sources continue syncing. Keys are used only for authenticated model-list requests and are never written to generated files or logs.

### Credential Setup

Create a dedicated Anthropic Workspace for catalog discovery, then create a standard API key in Claude Console under **Settings > Workspaces > API Keys**. A standard Workspace key is sufficient; do not use an Anthropic Admin API key. Give it a descriptive name such as `HaloForge provider catalog sync`, store it in a secret manager, and choose an expiration that matches the team's rotation policy.

Add it to this repository without putting the value in shell history:

```bash
gh secret set ANTHROPIC_API_KEY \
  --repo HaloForgeAI/haloforge-ai-provider-catalog
```

The GitHub CLI prompts for the value. Paste the key only at that prompt, never into an issue, pull request, workflow file, or chat message.

Add the other provider keys the same way. Each command prompts for that provider's key:

```bash
gh secret set OPENAI_API_KEY --repo HaloForgeAI/haloforge-ai-provider-catalog
gh secret set GEMINI_API_KEY --repo HaloForgeAI/haloforge-ai-provider-catalog
gh secret set ZAI_API_KEY --repo HaloForgeAI/haloforge-ai-provider-catalog
gh secret set MINIMAX_API_KEY --repo HaloForgeAI/haloforge-ai-provider-catalog
gh secret set MOONSHOT_API_KEY --repo HaloForgeAI/haloforge-ai-provider-catalog
gh secret set DEEPSEEK_API_KEY --repo HaloForgeAI/haloforge-ai-provider-catalog
gh secret set DASHSCOPE_API_KEY --repo HaloForgeAI/haloforge-ai-provider-catalog
gh secret set MISTRAL_API_KEY --repo HaloForgeAI/haloforge-ai-provider-catalog
gh secret set XAI_API_KEY --repo HaloForgeAI/haloforge-ai-provider-catalog
gh secret set PERPLEXITY_API_KEY --repo HaloForgeAI/haloforge-ai-provider-catalog
```

The associated providers are OpenAI, Google Gemini, Z.AI/GLM, MiniMax, Moonshot/Kimi, DeepSeek, Alibaba Cloud/Qwen, Mistral, xAI, and Perplexity. Use standard inference API keys with access to `GET /models`; organization-admin keys are not required. Provider-specific availability can vary by account and region, so the sync never treats absence from one account-scoped response as an instruction to remove an existing catalog model.

For the sync pull-request credential, create a fine-grained GitHub personal access token with:

- Resource owner: `HaloForgeAI`
- Repository access: only `haloforge-ai-provider-catalog`
- Repository permissions: `Contents: Read and write` and `Pull requests: Read and write`
- A finite expiration with a scheduled rotation before expiry

If the organization requires approval for fine-grained tokens, approve the pending token request before testing the workflow. Add the generated value as:

```bash
gh secret set HF_PROVIDER_CATALOG_SYNC_TOKEN \
  --repo HaloForgeAI/haloforge-ai-provider-catalog
```

Confirm the secret names and trigger a test run:

```bash
gh secret list --repo HaloForgeAI/haloforge-ai-provider-catalog
gh workflow run sync-upstream-models.yml \
  --repo HaloForgeAI/haloforge-ai-provider-catalog
```

GitHub never returns stored secret values. Re-running `gh secret set` replaces a secret, which is the intended rotation procedure.

Each machine source declares a minimum expected model count. Required source failures or suspiciously small responses fail the workflow instead of producing a green no-op run. Discovery rules can also exclude non-interactive variants such as OpenRouter `:batch` model ids.

`managedFields` in `sources/model-sync.json` identifies fields owned by an upstream source. Those fields refresh on every run even though a last-known snapshot remains in the sync config. Use a model's `overrides` object only when a reviewed value must intentionally win over upstream metadata.

## Icon Metadata

`iconProvider` should use the lowercase brand keys understood by the HaloForge desktop `@lobehub/icons` resolver. Prefer the most specific visible product icon instead of a generic company icon:

- Amazon Bedrock: `bedrock`
- MiniMax: `minimax`
- Moonshot AI / Kimi: `kimi`
- Z.AI / GLM: `zai`
- Azure OpenAI: `azure`
- Alibaba Cloud / Qwen: `qwen`

If a provider has both a company brand and a model family brand, choose the user-facing model family for this catalog. For example, Moonshot API presets should show the Kimi icon because the model ids and gateway presets are Kimi-branded.

## Upstream Sources

Machine-readable sources are configured in `sources/upstreams.json`:

- LiteLLM model catalog: `https://api.litellm.ai/model_catalog`
- OpenRouter models API: `https://openrouter.ai/api/v1/models`
- Vercel AI Gateway models endpoint: `https://ai-gateway.vercel.sh/v1/models`
- Authenticated official model-list APIs for Anthropic, OpenAI, Google Gemini, Z.AI, MiniMax, Moonshot/Kimi, DeepSeek, Qwen/DashScope, Mistral, xAI, and Perplexity

Official sources own model identity and availability. Google Gemini and Anthropic also provide authoritative token limits. For providers whose list endpoint returns only model ids, curated fields remain authoritative and aggregator metadata only fills missing capacity values. New preview or experimental ids always require human review, and synchronization never removes an existing model automatically.

Official documentation sources are also recorded in `sources/upstreams.json` so a future maintainer can verify curated overrides quickly. Current official-doc references include OpenAI, Anthropic, DeepSeek, Z.AI/GLM, Gemini, Qwen/DashScope, MiniMax, Moonshot/Kimi, and Cloudflare Workers AI.

When a new model appears in official docs before every aggregator catches up, add it to `sources/model-sync.json` with explicit `contextWindow`, `maxTokens`, lifecycle fields, and `source`. GLM-5.2 is handled this way: Z.AI official docs define the 1M context and 128K max output, while OpenRouter and Vercel provide machine-readable confirmation.

## Catalog Contract

- `schemaVersion`: integer catalog schema version.
- `updatedAt`: ISO timestamp for cache/debug visibility.
- `providers`: provider templates used by the chat settings page and Agent gateway settings.
- `models`: chat model presets for a provider.
- `agentGateways`: target-specific templates for `claude_code`, `codex`, `opencode`, `copilot`, and `qwen_code`.
- `status`, `shutdownDate`, `fallbackModelId`, and `disabledByDefault`: lifecycle metadata used by HaloForge to avoid enabling unavailable models by default and to guide users toward fallbacks.

Gateway templates are presets only. HaloForge applies them to runtime agents only after a user explicitly adds or edits an Agent gateway config in the desktop app.
