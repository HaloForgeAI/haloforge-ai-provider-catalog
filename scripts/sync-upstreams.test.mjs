import assert from "node:assert/strict";
import test from "node:test";

import {
  discoverNewModels,
  matchesDiscoveryPolicy,
  normalizeAnthropicModel,
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
