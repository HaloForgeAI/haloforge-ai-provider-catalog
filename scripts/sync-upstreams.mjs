import { readdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../", import.meta.url);
const providersRoot = new URL("providers/", repoRoot);
const manifestPath = new URL("catalog/manifest.json", repoRoot);
const upstreamsPath = new URL("sources/upstreams.json", repoRoot);
const syncConfigPath = new URL("sources/model-sync.json", repoRoot);
const maxLiteLlmPages = Number(process.env.LITELLM_MAX_PAGES ?? 80);
const fetchTimeoutMs = Number(process.env.HF_SYNC_FETCH_TIMEOUT_MS ?? 20000);
const maxDiscoveredPerGroup = Number(process.env.HF_SYNC_MAX_DISCOVERED_PER_GROUP ?? 25);

async function main() {
  const upstreamConfig = await readJson(upstreamsPath);
  const syncConfig = await readJson(syncConfigPath);
  const sourceIndexes = await fetchSourceIndexes(upstreamConfig.machineSources ?? []);
  const providerFiles = await indexProviderFiles();
  let changed = false;
  let syncConfigChanged = false;

  for (const providerSync of syncConfig.providers ?? []) {
    const providerFile = providerFiles.get(providerSync.id);
    if (!providerFile) {
      console.warn(`Skipping unknown provider id from sync config: ${providerSync.id}`);
      continue;
    }
    const provider = await readJson(providerFile);
    const before = stableJson(provider);

    const discovered = discoverNewModels(provider, providerSync, sourceIndexes);
    if (discovered.length > 0) {
      providerSync.models = [...(providerSync.models ?? []), ...discovered];
      syncConfigChanged = true;
      console.log(
        `Discovered ${discovered.length} new model(s) for ${providerSync.id}: ${discovered
          .map((model) => model.id)
          .join(", ")}`,
      );
    }

    upsertModels(provider, providerSync.models ?? [], sourceIndexes, providerSync);
    upsertAgentGateways(provider, providerSync.agentGateways ?? []);
    const after = stableJson(provider);
    if (before !== after) {
      await writeJson(providerFile, provider);
      changed = true;
      console.log(`Updated ${pathLabel(providerFile)}`);
    }
  }

  if (syncConfigChanged) {
    await writeJson(syncConfigPath, syncConfig);
    console.log(`Updated ${pathLabel(syncConfigPath)} with newly discovered models.`);
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

/**
 * Find upstream models that share a namespace with a provider's already-tracked
 * models but are not tracked yet (e.g. a new "zai/glm-6" appears on the Vercel
 * AI Gateway alongside the already-tracked "zai/glm-5.2"). The namespace and
 * whether the local model id keeps or strips the upstream vendor prefix are
 * both inferred from existing examples — nothing here is hardcoded per
 * provider, so it only ever proposes siblings of models a human already
 * curated. Returns new model specs (in the `sources/model-sync.json` shape,
 * including `upstreamRefs`) ready to be appended to `providerSync.models`.
 */
export function discoverNewModels(provider, providerSync, sourceIndexes) {
  const groups = new Map();
  const trackedRefs = new Set();

  const addGroup = (source, namespace, stripPrefix) => {
    const key = `${source} ${namespace}`;
    if (!groups.has(key)) {
      groups.set(key, { source, namespace, stripPrefix });
    }
  };

  for (const spec of providerSync.models ?? []) {
    for (const ref of spec.upstreamRefs ?? []) {
      trackedRefs.add(ref);
      const sepIndex = ref.indexOf(":");
      if (sepIndex < 0) continue;
      const source = ref.slice(0, sepIndex);
      const modelId = ref.slice(sepIndex + 1);
      const namespace = modelId.includes("/") ? modelId.slice(0, modelId.lastIndexOf("/")) : "";
      const suffix = namespace ? modelId.slice(namespace.length + 1) : modelId;
      addGroup(source, namespace, namespace !== "" && spec.id === suffix);
    }
  }

  // Also learn namespace groups straight from the real provider file's
  // existing aggregator-style entries (local id already equals the full
  // upstream id), so a provider like "openrouter" keeps discovering sibling
  // vendors even for namespaces that were hand-added before any sync spec
  // existed for them.
  for (const model of provider.models ?? []) {
    if (!model.source || !sourceIndexes.has(model.source) || !model.id?.includes("/")) continue;
    addGroup(model.source, model.id.slice(0, model.id.lastIndexOf("/")), false);
  }

  const existingIds = new Set([
    ...(providerSync.models ?? []).map((spec) => spec.id),
    ...(provider.models ?? []).map((model) => model.id),
  ]);

  const discovered = [];
  for (const { source, namespace, stripPrefix } of groups.values()) {
    const index = sourceIndexes.get(source);
    if (!index) continue;
    let addedFromGroup = 0;
    const groupLimit = Number(providerSync.discovery?.maxPerGroup ?? maxDiscoveredPerGroup);
    for (const [upstreamId, model] of index) {
      if (addedFromGroup >= groupLimit) break;
      const modelNamespace = upstreamId.includes("/") ? upstreamId.slice(0, upstreamId.lastIndexOf("/")) : "";
      if (modelNamespace !== namespace) continue;
      if (!matchesDiscoveryPolicy(upstreamId, providerSync.discovery)) continue;
      const ref = `${source}:${upstreamId}`;
      if (trackedRefs.has(ref)) continue;
      const localId = stripPrefix ? upstreamId.slice(namespace.length + 1) : upstreamId;
      if (existingIds.has(localId)) continue;
      discovered.push({
        id: localId,
        displayName: model.displayName ?? localId,
        upstreamRefs: [ref],
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        status: model.lifecycle?.status ?? "available",
        shutdownDate: model.lifecycle?.shutdownDate,
        disabledByDefault: model.lifecycle?.disabledByDefault,
        source,
      });
      existingIds.add(localId);
      trackedRefs.add(ref);
      addedFromGroup += 1;
    }
  }

  return discovered;
}

export function matchesDiscoveryPolicy(modelId, discovery = {}) {
  const includePatterns = compilePatterns(discovery?.includePatterns);
  const excludePatterns = compilePatterns(discovery?.excludePatterns);
  if (includePatterns.length > 0 && !includePatterns.some((pattern) => pattern.test(modelId))) {
    return false;
  }
  return !excludePatterns.some((pattern) => pattern.test(modelId));
}

function compilePatterns(values) {
  return (Array.isArray(values) ? values : [])
    .filter(nonEmpty)
    .map((value) => new RegExp(value));
}

async function fetchSourceIndexes(machineSources) {
  const indexes = new Map();
  const requiredFailures = [];
  for (const source of machineSources) {
    const secret = source.authEnv ? process.env[source.authEnv]?.trim() : "";
    if (source.authEnv && !secret) {
      const message = `Skipping ${source.id}: environment variable ${source.authEnv} is not configured.`;
      if (source.required !== false) {
        requiredFailures.push(message);
      } else {
        console.warn(message);
      }
      indexes.set(source.id, new Map());
      continue;
    }
    try {
      const models = await fetchSourceModels(source, secret);
      const minimumModels = Number(source.minimumModels ?? 1);
      if (models.length < minimumModels) {
        throw new Error(`expected at least ${minimumModels} models, received ${models.length}`);
      }
      const byId = new Map(models.map((model) => [model.id, model]));
      indexes.set(source.id, byId);
      console.log(`Fetched ${models.length} models from ${source.id}.`);
    } catch (error) {
      const message = `Failed to fetch ${source.id}: ${error.message}`;
      if (source.required !== false || Boolean(secret)) {
        requiredFailures.push(message);
      } else {
        console.warn(message);
      }
      indexes.set(source.id, new Map());
    }
  }
  if (requiredFailures.length > 0) {
    throw new Error(`Required upstream source checks failed:\n${requiredFailures.join("\n")}`);
  }
  return indexes;
}

async function fetchSourceModels(source, secret = "") {
  if (source.parser === "litellm") {
    return fetchLiteLlmModels(source);
  }
  if (source.parser === "anthropic") {
    return fetchAnthropicModels(source, secret);
  }
  const json = await fetchJson(source.url, sourceHeaders(source, secret));
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  if (source.parser === "openrouter") {
    return rows.map((item) => normalizeOpenRouterModel(source.id, item)).filter(Boolean);
  }
  if (source.parser === "vercel-ai-gateway") {
    return rows.map((item) => normalizeVercelModel(source.id, item)).filter(Boolean);
  }
  return [];
}

async function fetchAnthropicModels(source, secret) {
  const models = [];
  let afterId = "";
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(source.url);
    url.searchParams.set("limit", "1000");
    if (afterId) url.searchParams.set("after_id", afterId);
    const json = await fetchJson(url.toString(), sourceHeaders(source, secret));
    const rows = Array.isArray(json?.data) ? json.data : [];
    models.push(...rows.map((item) => normalizeAnthropicModel(source.id, item)).filter(Boolean));
    if (!json?.has_more || !nonEmpty(json?.last_id) || rows.length === 0) break;
    afterId = json.last_id.trim();
  }
  return models;
}

function sourceHeaders(source, secret) {
  const headers = { ...(source.headers ?? {}) };
  if (secret && nonEmpty(source.authHeader)) {
    headers[source.authHeader] = secret;
  }
  return headers;
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

async function fetchJson(url, extraHeaders = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "HaloForgeAI/ai-provider-catalog-sync",
        ...extraHeaders,
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

export function normalizeAnthropicModel(sourceId, item) {
  if (!nonEmpty(item?.id)) return null;
  return {
    id: item.id.trim(),
    displayName: nonEmpty(item.display_name) ? item.display_name.trim() : item.id.trim(),
    contextWindow: positiveIntegerValue(item.max_input_tokens),
    maxTokens: positiveIntegerValue(item.max_tokens),
    lifecycle: null,
    source: sourceId,
  };
}

function cleanOpenRouterName(name) {
  if (!nonEmpty(name)) return null;
  return name.replace(/^[^:]+:\s*/, "").trim();
}

const deprecationHorizonMs = 2 * 365 * 24 * 3600 * 1000;

function lifecycleFromDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const isoDate = date.toISOString().replace(/T.*$/, "");
  if (date.getTime() <= Date.now()) {
    return { status: "shutdown", shutdownDate: isoDate, disabledByDefault: true };
  }
  if (date.getTime() - Date.now() > deprecationHorizonMs) {
    // Some upstreams attach a far-future placeholder expiration date to
    // otherwise-current models; treat those as "no known lifecycle" rather
    // than flagging a model as deprecated decades in advance.
    return null;
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

export function upsertModels(provider, modelSpecs, sourceIndexes, providerSync = {}) {
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
    const managedFields = new Set(providerSync.managedFields ?? []);
    const overrides = spec.overrides ?? {};
    const choose = (field, upstreamValue, fallbackValue = existing[field]) => {
      if (Object.hasOwn(overrides, field)) return overrides[field];
      if (managedFields.has(field)) return upstreamValue ?? spec[field] ?? fallbackValue;
      return spec[field] ?? upstreamValue ?? fallbackValue;
    };
    const next = {
      ...existing,
      id: spec.id,
      displayName: choose("displayName", upstream?.displayName, spec.id),
    };
    applyDefined(next, {
      description: choose("description", upstream?.description),
      contextWindow: choose("contextWindow", upstream?.contextWindow),
      maxTokens: choose("maxTokens", upstream?.maxTokens),
      status: choose("status", upstream?.lifecycle?.status),
      deprecationDate: choose("deprecationDate", upstream?.lifecycle?.deprecationDate),
      shutdownDate: choose("shutdownDate", upstream?.lifecycle?.shutdownDate),
      fallbackModelId: choose("fallbackModelId", upstream?.fallbackModelId),
      disabledByDefault: choose("disabledByDefault", upstream?.lifecycle?.disabledByDefault),
      source: choose("source", upstream?.source),
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

function positiveIntegerValue(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function pathLabel(url) {
  return relative(fileURLToPath(repoRoot), fileURLToPath(url)).replaceAll("\\", "/");
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
