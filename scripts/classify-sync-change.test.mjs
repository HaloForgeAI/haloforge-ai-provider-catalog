import assert from "node:assert/strict";
import test from "node:test";

import { classifyCatalogChange } from "./classify-sync-change.mjs";

function catalog(models, gateways = []) {
  return {
    schemaVersion: 1,
    source: "catalog",
    repository: "repo",
    providers: [{
      id: "provider",
      name: "Provider",
      agentGateways: gateways,
      models,
    }],
  };
}

test("newly discovered models require review even when existing metadata refreshes are safe", () => {
  const before = catalog([{ id: "model-a", displayName: "A", contextWindow: 100 }]);
  const after = catalog([
    { id: "model-a", displayName: "A", contextWindow: 200 },
    { id: "model-b", displayName: "B", status: "available" },
  ]);
  const result = classifyCatalogChange(before, after, [
    "catalog/model-provider-catalog.json",
    "providers/official/provider.json",
    "sources/model-sync.json",
  ]);
  assert.equal(result.safe, false);
  assert.deepEqual(result.reasons, ["provider: new model requires review: model-b"]);
});

test("lifecycle and gateway changes require review", () => {
  const before = catalog([{ id: "model-a", displayName: "A", status: "available" }]);
  const after = catalog(
    [{ id: "model-a", displayName: "A", status: "deprecated", shutdownDate: "2027-01-01" }],
    [{ id: "gateway", target: "codex", routeMode: "config_only" }],
  );
  const result = classifyCatalogChange(before, after, ["catalog/model-provider-catalog.json"]);
  assert.equal(result.safe, false);
  assert.match(result.reasons.join("\n"), /agent gateways changed/);
  assert.match(result.reasons.join("\n"), /status, shutdownDate/);
});

test("batch variants and model removals require review", () => {
  const before = catalog([{ id: "model-a", displayName: "A" }]);
  const after = catalog([{ id: "model-b:batch", displayName: "Batch" }]);
  const result = classifyCatalogChange(before, after, ["providers/official/provider.json"]);
  assert.equal(result.safe, false);
  assert.match(result.reasons.join("\n"), /model removed/);
  assert.match(result.reasons.join("\n"), /new model requires review/);
});
