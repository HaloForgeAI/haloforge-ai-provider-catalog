import { readdir, readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../", import.meta.url);
const providersRoot = new URL("providers/", repoRoot);
const manifestPath = new URL("catalog/manifest.json", repoRoot);
const upstreamsPath = new URL("sources/upstreams.json", repoRoot);
const syncConfigPath = new URL("sources/model-sync.json", repoRoot);
const maxLiteLlmPages = Number(process.env.LITELLM_MAX_PAGES ?? 80);
const fetchTimeoutMs = Number(process.env.HF_SYNC_FETCH_TIMEOUT_MS ?? 20000);

async function main() {
  const upstreamConfig = await readJson(upstreamsPath);
  const syncConfig = await readJson(syncConfigPath);
  const sourceIndexes = await fetchSourceIndexes(upstreamConfig.machineSources ?? []);
  const providerFiles = await indexProviderFiles();
  let changed = false;

  for (const providerSync of syncConfig.providers ?? []) {
    const providerFile = providerFiles.get(providerSync.id);
    if (!providerFile) {
      console.warn(`Skipping unknown provider id from sync config: ${providerSync.id}`);
      continue;
    }
    const provider = await readJson(providerFile);
    const before = stableJson(provider);
    upsertModels(provider, providerSync.models ?? [], sourceIndexes);
    upsertAgentGateways(provider, providerSync.agentGateways ?? []);
    const after = stableJson(provider);
    if (before !== after) {
      await writeJson(providerFile, provider);
      changed = true;
      console.log(`Updated ${pathLabel(providerFile)}`);
    }
  }

  if (changed) {
    const manifest = await readJson(manifestPath);
    manifest.updatedAt = new Date().toISOString();
    await writeJson(manifestPath, manifest);
    console.log(`Updated ${pathLabel(manifestPath)} timestamp.`);
  } else {
    console.log("No upstream sync changes.");
  }
}

async function fetchSourceIndexes(machineSources) {
  const indexes = new Map();
  for (const source of machineSources) {
    try {
      const models = await fetchSourceModels(source);
      const byId = new Map(models.map((model) => [model.id, model]));
      indexes.set(source.id, byId);
      console.log(`Fetched ${models.length} models from ${source.id}.`);
    } catch (error) {
      console.warn(`Failed to fetch ${source.id}: ${error.message}`);
      indexes.set(source.id, new Map());
    }
  }
  return indexes;
}

async function fetchSourceModels(source) {
  if (source.parser === "litellm") {
    return fetchLiteLlmModels(source);
  }
  const json = await fetchJson(source.url);
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  if (source.parser === "openrouter") {
    return rows.map((item) => normalizeOpenRouterModel(source.id, item)).filter(Boolean);
  }
  if (source.parser === "vercel-ai-gateway") {
    return rows.map((item) => normalizeVercelModel(source.id, item)).filter(Boolean);
  }
  return [];
}

async function fetchLiteLlmModels(source) {
  const models = [];
  for (let page = 1; page <= maxLiteLlmPages; page += 1) {
    const url = new URL(source.url);
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", "100");
    const json = await fetchJson(url.toString());
    const rows = Array.isArray(json?.data) ? json.data : [];
    models.push(...rows.map((item) => normalizeLiteLlmModel(source.id, item)).filter(Boolean));
    if (!json?.has_more || rows.length === 0) {
      break;
    }
  }
  return models;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "HaloForgeAI/ai-provider-catalog-sync",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeLiteLlmModel(sourceId, item) {
  if (!nonEmpty(item?.id)) return null;
  return {
    id: item.id.trim(),
    displayName: item.id.trim(),
    contextWindow: numberValue(item.max_input_tokens),
    maxTokens: numberValue(item.max_output_tokens) ?? numberValue(item.max_tokens),
    lifecycle: lifecycleFromDate(item.deprecation_date),
    source: sourceId,
  };
}

function normalizeOpenRouterModel(sourceId, item) {
  if (!nonEmpty(item?.id)) return null;
  return {
    id: item.id.trim(),
    displayName: cleanOpenRouterName(item.name) ?? item.id.trim(),
    contextWindow: numberValue(item.top_provider?.context_length) ?? numberValue(item.context_length),
    maxTokens: numberValue(item.top_provider?.max_completion_tokens),
    lifecycle: lifecycleFromDate(item.expiration_date),
    source: sourceId,
  };
}

function normalizeVercelModel(sourceId, item) {
  if (!nonEmpty(item?.id)) return null;
  return {
    id: item.id.trim(),
    displayName: nonEmpty(item.name) ? item.name.trim() : item.id.trim(),
    contextWindow: numberValue(item.context_window),
    maxTokens: numberValue(item.max_tokens),
    lifecycle: null,
    source: sourceId,
  };
}

function cleanOpenRouterName(name) {
  if (!nonEmpty(name)) return null;
  return name.replace(/^[^:]+:\s*/, "").trim();
}

function lifecycleFromDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const isoDate = date.toISOString().replace(/T.*$/, "");
  if (date.getTime() <= Date.now()) {
    return { status: "shutdown", shutdownDate: isoDate, disabledByDefault: true };
  }
  return { status: "deprecated", shutdownDate: isoDate, disabledByDefault: true };
}

async function indexProviderFiles() {
  const files = await listJsonFiles(providersRoot);
  const byId = new Map();
  for (const file of files) {
    const provider = await readJson(file);
    if (nonEmpty(provider.id)) {
      byId.set(provider.id, file);
    }
  }
  return byId;
}

function upsertModels(provider, modelSpecs, sourceIndexes) {
  if (!Array.isArray(provider.models)) {
    provider.models = [];
  }
  const byId = new Map(provider.models.map((model) => [model.id, model]));
  const preferredOrder = [];
  for (const spec of modelSpecs) {
    if (!nonEmpty(spec.id)) continue;
    preferredOrder.push(spec.id);
    const upstream = firstUpstreamModel(spec.upstreamRefs ?? [], sourceIndexes);
    const existing = byId.get(spec.id) ?? {};
    const next = {
      ...existing,
      id: spec.id,
      displayName: spec.displayName ?? existing.displayName ?? upstream?.displayName ?? spec.id,
    };
    applyDefined(next, {
      description: spec.description ?? existing.description,
      contextWindow: spec.contextWindow ?? upstream?.contextWindow ?? existing.contextWindow,
      maxTokens: spec.maxTokens ?? upstream?.maxTokens ?? existing.maxTokens,
      status: spec.status ?? upstream?.lifecycle?.status ?? existing.status,
      deprecationDate: spec.deprecationDate ?? upstream?.lifecycle?.deprecationDate ?? existing.deprecationDate,
      shutdownDate: spec.shutdownDate ?? upstream?.lifecycle?.shutdownDate ?? existing.shutdownDate,
      fallbackModelId: spec.fallbackModelId ?? existing.fallbackModelId,
      disabledByDefault: spec.disabledByDefault ?? upstream?.lifecycle?.disabledByDefault ?? existing.disabledByDefault,
      source: spec.source ?? upstream?.source ?? existing.source,
    });
    byId.set(spec.id, next);
  }
  provider.models = sortByPreferredOrder(Array.from(byId.values()), preferredOrder);
}

function upsertAgentGateways(provider, gatewaySpecs) {
  if (!Array.isArray(provider.agentGateways)) {
    provider.agentGateways = [];
  }
  const byId = new Map(provider.agentGateways.filter((gateway) => nonEmpty(gateway.id)).map((gateway) => [gateway.id, gateway]));
  const anonymous = provider.agentGateways.filter((gateway) => !nonEmpty(gateway.id));
  const preferredOrder = [];
  for (const gateway of gatewaySpecs) {
    if (!nonEmpty(gateway.id)) continue;
    preferredOrder.push(gateway.id);
    byId.set(gateway.id, {
      ...(byId.get(gateway.id) ?? {}),
      ...gateway,
    });
  }
  provider.agentGateways = [
    ...sortByPreferredOrder(Array.from(byId.values()), preferredOrder),
    ...anonymous,
  ];
}

function firstUpstreamModel(refs, sourceIndexes) {
  for (const ref of refs) {
    const [sourceId, ...modelParts] = String(ref).split(":");
    const modelId = modelParts.join(":");
    if (!sourceId || !modelId) continue;
    const model = sourceIndexes.get(sourceId)?.get(modelId);
    if (model) return model;
  }
  return null;
}

function sortByPreferredOrder(items, preferredIds) {
  const order = new Map(preferredIds.map((id, index) => [id, index]));
  return items.sort((left, right) => {
    const leftOrder = order.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = order.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    return String(left.id).localeCompare(String(right.id));
  });
}

function applyDefined(target, values) {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      target[key] = value;
    }
  }
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

async function writeJson(url, value) {
  await writeFile(url, `${stableJson(value)}\n`, "utf8");
}

function stableJson(value) {
  return JSON.stringify(value, null, 2);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pathLabel(url) {
  return relative(fileURLToPath(repoRoot), fileURLToPath(url)).replaceAll("\\", "/");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
