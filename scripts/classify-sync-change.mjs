import { appendFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const safeExistingModelFields = new Set([
  "displayName",
  "description",
  "contextWindow",
  "maxTokens",
  "source",
]);
const allowedGeneratedPaths = [
  /^catalog\/manifest\.json$/,
  /^catalog\/model-provider-catalog\.json$/,
  /^providers\/.+\.json$/,
  /^sources\/model-sync\.json$/,
];
const riskyModelIdPatterns = [/:batch$/, /(?:^|[-/:])preview(?:$|[-/:])/i];

export function classifyCatalogChange(before, after, changedPaths = []) {
  const reasons = [];
  const unsafePaths = changedPaths.filter(
    (path) => !allowedGeneratedPaths.some((pattern) => pattern.test(path)),
  );
  if (unsafePaths.length > 0) {
    reasons.push(`non-generated files changed: ${unsafePaths.join(", ")}`);
  }

  for (const field of ["schemaVersion", "source", "repository"]) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
      reasons.push(`catalog ${field} changed`);
    }
  }

  const beforeProviders = byId(before.providers);
  const afterProviders = byId(after.providers);
  compareIdSets("provider", beforeProviders, afterProviders, reasons);

  for (const [providerId, beforeProvider] of beforeProviders) {
    const afterProvider = afterProviders.get(providerId);
    if (!afterProvider) continue;
    const { models: beforeModelsValue, ...beforeMetadata } = beforeProvider;
    const { models: afterModelsValue, ...afterMetadata } = afterProvider;
    if (JSON.stringify(beforeMetadata) !== JSON.stringify(afterMetadata)) {
      reasons.push(`${providerId}: provider metadata or agent gateways changed`);
    }

    const beforeModels = byId(beforeModelsValue);
    const afterModels = byId(afterModelsValue);
    for (const modelId of beforeModels.keys()) {
      if (!afterModels.has(modelId)) reasons.push(`${providerId}: model removed: ${modelId}`);
    }
    for (const [modelId, afterModel] of afterModels) {
      const beforeModel = beforeModels.get(modelId);
      if (!beforeModel) {
        if (!isSafeNewModel(afterModel)) {
          reasons.push(`${providerId}: new model requires review: ${modelId}`);
        }
        continue;
      }
      const changedFields = changedObjectFields(beforeModel, afterModel);
      const riskyFields = changedFields.filter((field) => !safeExistingModelFields.has(field));
      if (riskyFields.length > 0) {
        reasons.push(`${providerId}/${modelId}: review fields changed: ${riskyFields.join(", ")}`);
      }
    }
  }

  return { safe: reasons.length === 0, reasons };
}

function isSafeNewModel(model) {
  if (riskyModelIdPatterns.some((pattern) => pattern.test(model.id))) return false;
  if (model.disabledByDefault === true) return false;
  return model.status === undefined || model.status === "available";
}

function changedObjectFields(before, after) {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  return Array.from(fields).filter(
    (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
  );
}

function byId(items) {
  return new Map((Array.isArray(items) ? items : []).map((item) => [item.id, item]));
}

function compareIdSets(label, before, after, reasons) {
  for (const id of before.keys()) {
    if (!after.has(id)) reasons.push(`${label} removed: ${id}`);
  }
  for (const id of after.keys()) {
    if (!before.has(id)) reasons.push(`${label} added: ${id}`);
  }
}

async function main() {
  const before = JSON.parse(execFileSync(
    "git",
    ["show", "HEAD:catalog/model-provider-catalog.json"],
    { encoding: "utf8" },
  ));
  const after = JSON.parse(await readFile("catalog/model-provider-catalog.json", "utf8"));
  const changedPaths = execFileSync("git", ["diff", "--name-only"], { encoding: "utf8" })
    .split("\n")
    .map((path) => path.trim())
    .filter(Boolean);
  const result = classifyCatalogChange(before, after, changedPaths);
  const summary = result.safe
    ? "safe model additions or metadata refresh only"
    : result.reasons.join("; ");
  console.log(`Sync change classification: ${result.safe ? "safe" : "review_required"}`);
  console.log(summary);

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `safe=${result.safe}\nsummary=${summary.replaceAll("\n", " ")}\n`);
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
