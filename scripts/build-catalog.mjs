import { readdir, readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../", import.meta.url);
const providersRoot = new URL("providers/", repoRoot);
const manifestPath = new URL("catalog/manifest.json", repoRoot);
const outputPath = new URL("catalog/model-provider-catalog.json", repoRoot);
const checkOnly = process.argv.includes("--check");
const gatewayTargets = new Set(["claude_code", "codex", "opencode", "copilot", "qwen_code"]);
const forbiddenSecretKeys = new Set([
  "apikey",
  "api_key",
  "token",
  "accesstoken",
  "access_token",
  "authorization",
]);

async function main() {
  const manifest = await readJson(manifestPath);
  const providerFiles = await listJsonFiles(providersRoot);
  if (providerFiles.length === 0) {
    throw new Error("No provider fragments found under providers/.");
  }

  const providerOrder = new Map(
    Array.isArray(manifest.providerOrder)
      ? manifest.providerOrder.map((id, index) => [id, index])
      : [],
  );
  const providers = [];
  const providerIds = new Set();
  for (const file of providerFiles.sort((a, b) => pathLabel(a).localeCompare(pathLabel(b)))) {
    const provider = await readJson(file);
    validateProvider(provider, file, providerIds);
    providers.push(provider);
  }
  providers.sort((left, right) => {
    const leftOrder = providerOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = providerOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.id.localeCompare(right.id);
  });

  const { $schema, providerOrder: _providerOrder, ...publicManifest } = manifest;
  const catalog = {
    ...publicManifest,
    providers,
  };
  const next = `${JSON.stringify(catalog, null, 2)}\n`;
  if (checkOnly) {
    const current = await readFile(outputPath, "utf8").catch(() => "");
    if (current !== next) {
      throw new Error("catalog/model-provider-catalog.json is stale. Run npm run build.");
    }
    console.log(`Catalog is up to date (${providers.length} providers).`);
    return;
  }

  await writeFile(outputPath, next, "utf8");
  console.log(`Wrote ${pathLabel(outputPath)} with ${providers.length} providers.`);
}

async function listJsonFiles(rootUrl) {
  const entries = await readdir(rootUrl, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, rootUrl);
    if (entry.isDirectory()) {
      files.push(...(await listJsonFiles(child)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(child);
    }
  }
  return files;
}

async function readJson(url) {
  const raw = await readFile(url, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${pathLabel(url)} is not valid JSON: ${error.message}`);
  }
}

function validateProvider(provider, file, providerIds) {
  const label = pathLabel(file);
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    throw new Error(`${label} must contain one provider object.`);
  }
  if (!nonEmpty(provider.id)) {
    throw new Error(`${label} is missing provider id.`);
  }
  if (providerIds.has(provider.id)) {
    throw new Error(`Duplicate provider id: ${provider.id}`);
  }
  providerIds.add(provider.id);
  for (const key of ["name", "category", "iconProvider", "apiCompatibility", "authType"]) {
    if (!nonEmpty(provider[key])) {
      throw new Error(`${label} is missing ${key}.`);
    }
  }
  if (!Array.isArray(provider.models)) {
    throw new Error(`${label} must define models[].`);
  }
  for (const [index, model] of provider.models.entries()) {
    if (!nonEmpty(model?.id) || !nonEmpty(model?.displayName)) {
      throw new Error(`${label} models[${index}] must define id and displayName.`);
    }
  }
  if (!Array.isArray(provider.agentGateways)) {
    throw new Error(`${label} must define agentGateways[].`);
  }
  for (const [index, gateway] of provider.agentGateways.entries()) {
    if (!gatewayTargets.has(gateway?.target)) {
      throw new Error(`${label} agentGateways[${index}] has unsupported target.`);
    }
    if (!nonEmpty(gateway.routeMode)) {
      throw new Error(`${label} agentGateways[${index}] is missing routeMode.`);
    }
  }
  assertNoEmbeddedSecrets(provider, label);
}

function assertNoEmbeddedSecrets(value, label, path = []) {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoEmbeddedSecrets(item, label, [...path, index]));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z_]/g, "");
    if (forbiddenSecretKeys.has(normalized)) {
      throw new Error(`${label} contains a secret-like key at ${[...path, key].join(".")}.`);
    }
    assertNoEmbeddedSecrets(child, label, [...path, key]);
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function pathLabel(url) {
  return relative(fileURLToPath(repoRoot), fileURLToPath(url)).replaceAll("\\", "/");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
