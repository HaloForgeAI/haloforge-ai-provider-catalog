import assert from "node:assert/strict";
import test from "node:test";

import {
  discoverNewModels,
  expandModelSpecs,
  matchesDiscoveryPolicy,
  normalizeAnthropicModel,
  normalizeGoogleModel,
  normalizeOpenAiCompatibleModel,
  upsertModels,
} from "./sync-upstreams.mjs";

test("managed fields follow upstream while explicit overrides remain curated", () => {
  const provider = {
    models: [{ id: "model-a", displayName: "Old name", contextWindow: 100, maxTokens: 10 }],
  };
  const sourceIndexes = new Map([
    ["source", new Map([
      ["model-a", {
        id: "model-a",
        displayName: "Upstream name",
        contextWindow: 200,
        maxTokens: 20,
        source: "source",
      }],
    ])],
  ]);

  upsertModels(provider, [{
    id: "model-a",
    displayName: "Snapshot name",
    contextWindow: 150,
    maxTokens: 15,
    upstreamRefs: ["source:model-a"],
    overrides: { maxTokens: 30 },
  }], sourceIndexes, {
    managedFields: ["displayName", "contextWindow", "maxTokens", "source"],
  });

  assert.deepEqual(provider.models[0], {
    id: "model-a",
    displayName: "Upstream name",
    contextWindow: 200,
    maxTokens: 30,
    source: "source",
  });
});

test("managed fields keep existing reviewed values when an optional source is unavailable", () => {
  const provider = {
    models: [{
      id: "gpt-5",
      displayName: "GPT-5",
      contextWindow: 400_000,
      source: "openai-models-docs",
    }],
  };

  upsertModels(provider, [{
    id: "gpt-5",
    upstreamRefs: ["openai-models-api:gpt-5"],
  }], new Map([
    ["openai-models-api", new Map()],
  ]), {
    managedFields: ["displayName", "contextWindow", "source"],
  });

  assert.deepEqual(provider.models[0], {
    id: "gpt-5",
    displayName: "GPT-5",
    contextWindow: 400_000,
    source: "openai-models-docs",
  });
});

test("discovery policy excludes non-interactive variants", () => {
  const policy = {
    includePatterns: ["^vendor/"],
    excludePatterns: [":batch$", ":free$"],
  };
  assert.equal(matchesDiscoveryPolicy("vendor/chat", policy), true);
  assert.equal(matchesDiscoveryPolicy("vendor/chat:batch", policy), false);
  assert.equal(matchesDiscoveryPolicy("other/chat", policy), false);
});

test("discovery applies filters before adding namespace siblings", () => {
  const provider = {
    models: [{ id: "vendor/seed", displayName: "Seed", source: "source" }],
  };
  const providerSync = {
    id: "provider",
    models: [{ id: "vendor/seed", upstreamRefs: ["source:vendor/seed"] }],
    discovery: { excludePatterns: [":batch$"] },
  };
  const sourceIndexes = new Map([
    ["source", new Map([
      ["vendor/seed", { id: "vendor/seed" }],
      ["vendor/new", { id: "vendor/new", displayName: "New" }],
      ["vendor/new:batch", { id: "vendor/new:batch", displayName: "Batch" }],
    ])],
  ]);

  assert.deepEqual(discoverNewModels(provider, providerSync, sourceIndexes).map((model) => model.id), [
    "vendor/new",
  ]);
});

test("provider discovery ignores aggregator-only models when an official source is required", () => {
  const provider = {
    models: [{ id: "gpt-5", displayName: "GPT-5" }],
  };
  const providerSync = {
    upstreamModelRefs: [
      { source: "openai-models-api" },
      { source: "vercel-ai-gateway-models", prefix: "openai/" },
    ],
    discovery: {
      sources: ["openai-models-api"],
      includePatterns: ["^gpt-"],
    },
  };
  const expanded = expandModelSpecs(provider, providerSync);
  const sourceIndexes = new Map([
    ["openai-models-api", new Map()],
    ["vercel-ai-gateway-models", new Map([
      ["openai/gpt-unreviewed", { id: "openai/gpt-unreviewed" }],
    ])],
  ]);

  assert.deepEqual(discoverNewModels(
    provider,
    { ...providerSync, models: expanded },
    sourceIndexes,
  ), []);
});

test("provider ref mappings connect official ids to aggregator metadata", () => {
  const provider = {
    models: [{ id: "gpt-6", displayName: "GPT 6", contextWindow: 1_000_000 }],
  };
  const specs = expandModelSpecs(provider, {
    upstreamModelRefs: [
      { source: "openai-models-api" },
      { source: "vercel-ai-gateway-models", prefix: "openai/" },
    ],
  });

  assert.deepEqual(specs[0].upstreamRefs, [
    "openai-models-api:gpt-6",
    "vercel-ai-gateway-models:openai/gpt-6",
  ]);
});

test("official identity and aggregator capacity metadata merge field by field", () => {
  const provider = {
    models: [{ id: "model-a", displayName: "Curated", contextWindow: 100, maxTokens: 10 }],
  };
  const sourceIndexes = new Map([
    ["official", new Map([["model-a", {
      id: "model-a",
      displayName: "Official",
      lifecycle: null,
      source: "official",
    }]])],
    ["aggregator", new Map([["vendor/model-a", {
      id: "vendor/model-a",
      contextWindow: 200,
      maxTokens: 20,
      source: "aggregator",
    }]])],
  ]);

  upsertModels(provider, [{
    id: "model-a",
    upstreamRefs: ["official:model-a", "aggregator:vendor/model-a"],
  }], sourceIndexes, {
    managedFields: ["displayName", "contextWindow", "maxTokens", "source"],
  });

  assert.deepEqual(provider.models[0], {
    id: "model-a",
    displayName: "Official",
    contextWindow: 200,
    maxTokens: 20,
    source: "official",
  });
});

test("Anthropic model metadata maps into the shared catalog shape", () => {
  assert.deepEqual(normalizeAnthropicModel("anthropic-models-api", {
    id: "claude-sonnet-5",
    display_name: "Claude Sonnet 5",
    max_input_tokens: 1_000_000,
    max_tokens: 131_072,
  }), {
    id: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    lifecycle: null,
    source: "anthropic-models-api",
  });
});

test("Anthropic placeholder token limits do not overwrite curated values", () => {
  assert.deepEqual(normalizeAnthropicModel("anthropic-models-api", {
    id: "claude-opus-5",
    display_name: "Claude Opus 5",
    max_input_tokens: 0,
    max_tokens: 0,
  }), {
    id: "claude-opus-5",
    displayName: "Claude Opus 5",
    contextWindow: undefined,
    maxTokens: undefined,
    lifecycle: null,
    source: "anthropic-models-api",
  });
});

test("OpenAI-compatible model lists mark preview ids for review", () => {
  assert.deepEqual(normalizeOpenAiCompatibleModel("moonshot-models-api", {
    id: "kimi-k4-preview",
    owned_by: "moonshot",
  }), {
    id: "kimi-k4-preview",
    displayName: "kimi-k4-preview",
    description: undefined,
    contextWindow: undefined,
    maxTokens: undefined,
    lifecycle: { status: "preview" },
    source: "moonshot-models-api",
  });
});

test("Google model metadata maps token limits and excludes embedding-only entries", () => {
  assert.deepEqual(normalizeGoogleModel("google-models-api", {
    name: "models/gemini-4-flash",
    baseModelId: "gemini-4-flash",
    displayName: "Gemini 4 Flash",
    description: "General-purpose model",
    inputTokenLimit: 1_048_576,
    outputTokenLimit: 65_536,
    supportedGenerationMethods: ["generateContent", "countTokens"],
  }), {
    id: "gemini-4-flash",
    displayName: "Gemini 4 Flash",
    description: "General-purpose model",
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    lifecycle: null,
    source: "google-models-api",
  });
  assert.equal(normalizeGoogleModel("google-models-api", {
    name: "models/text-embedding-next",
    supportedGenerationMethods: ["embedContent"],
  }), null);
});
