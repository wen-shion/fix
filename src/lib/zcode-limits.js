const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_BILLING_BASE_URL = "https://zcode.z.ai/api/v1/zcode-plan";

function resolveZcodeHome({ home, env = process.env } = {}) {
  if (typeof env.TOKENTRACKER_ZCODE_HOME === "string" && env.TOKENTRACKER_ZCODE_HOME.trim()) {
    return path.resolve(env.TOKENTRACKER_ZCODE_HOME.trim());
  }
  if (typeof env.ZCODE_HOME === "string" && env.ZCODE_HOME.trim()) {
    return path.resolve(env.ZCODE_HOME.trim());
  }
  return path.join(home || os.homedir(), ".zcode");
}

function resolveZcodeBillingBaseUrl(env = process.env) {
  const explicit =
    typeof env.TOKENTRACKER_ZCODE_BILLING_BASE_URL === "string"
      ? env.TOKENTRACKER_ZCODE_BILLING_BASE_URL.trim()
      : "";
  if (explicit) return explicit.replace(/\/$/, "");
  return DEFAULT_BILLING_BASE_URL;
}

function isZcodeInstalled({ home, env } = {}) {
  const zcodeHome = resolveZcodeHome({ home, env });
  const configPath = path.join(zcodeHome, "v2", "config.json");
  if (fs.existsSync(configPath)) return true;
  const dbPath = path.join(zcodeHome, "cli", "db", "db.sqlite");
  return fs.existsSync(dbPath);
}

function loadZcodeApiKey({ home, env } = {}) {
  const zcodeHome = resolveZcodeHome({ home, env });
  const configPath = path.join(zcodeHome, "v2", "config.json");
  if (!fs.existsSync(configPath)) return null;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!config || typeof config !== "object") return null;
    const providers = config.provider || {};
    // Try the active start-plan first, then coding-plan variants
    const candidates = [
      "builtin:bigmodel-start-plan",
      "builtin:zai-start-plan",
      "builtin:bigmodel-coding-plan",
      "builtin:zai-coding-plan",
    ];
    for (const key of candidates) {
      const provider = providers[key];
      if (!provider || typeof provider !== "object") continue;
      if (provider.enabled === false) continue;
      const apiKey = typeof provider?.options?.apiKey === "string" ? provider.options.apiKey.trim() : "";
      if (apiKey) return { apiKey, providerKey: key, baseUrl: provider?.options?.baseURL || null };
    }
    return null;
  } catch (_error) {
    return null;
  }
}

function zcodeValNumber(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function zcodeTsToIso(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value * 1000).toISOString();
  }
  return null;
}

function clampPercent(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 0;
  if (n >= 100) return 100;
  return n;
}

function buildWindow({ usedPercent, resetAt }) {
  const pct = clampPercent(usedPercent);
  if (pct === null) return null;
  return {
    used_percent: pct,
    reset_at: typeof resetAt === "string" && resetAt ? resetAt : null,
  };
}

// Z.ai coding-plan ids look like "zcode-v3-start-plan-0615". The raw id reads
// terribly as a plan label, so extract just the human tier ("Start"/"Lite"/
// "Pro"/"Max"); fall back to null (→ bare "ZCode") when no known tier matches.
function deriveZcodePlanLabel(planId) {
  if (typeof planId !== "string" || !planId) return null;
  const m = planId.toLowerCase().match(/\b(lite|start|pro|max|team|enterprise)\b/);
  if (!m) return null;
  return m[1].charAt(0).toUpperCase() + m[1].slice(1);
}

function normalizeZcodeBalanceResponse(body) {
  const data = body?.data;
  if (!data || typeof data !== "object") {
    throw new Error("Could not parse ZCode balance: missing data");
  }

  const balances = Array.isArray(data.balances) ? data.balances : [];
  if (!balances.length) {
    throw new Error("Could not parse ZCode balance: no balance buckets");
  }

  const serverTime = zcodeValNumber(data.server_time);
  const buckets = balances.map((b) => {
    const total = zcodeValNumber(b.total_units);
    const used = zcodeValNumber(b.used_units);
    const remaining = zcodeValNumber(b.remaining_units);
    const periodEnd = zcodeValNumber(b.period_end) || zcodeValNumber(b.expires_at);
    const resetAt = zcodeTsToIso(periodEnd);
    const usedPercent =
      total != null && total > 0 && used != null ? (used / total) * 100 : null;

    return {
      show_name: typeof b.show_name === "string" ? b.show_name : "",
      entitlement_id: typeof b.entitlement_id === "string" ? b.entitlement_id : "",
      total_units: total,
      used_units: used,
      remaining_units: remaining,
      window: buildWindow({ usedPercent, resetAt }),
    };
  });

  // Primary window: highest-priority bucket (GLM-5.2 typically)
  // Secondary window: second bucket (GLM-5-Turbo typically)
  const sorted = buckets.slice().sort((a, b) => {
    const aTotal = a.total_units || 0;
    const bTotal = b.total_units || 0;
    return bTotal - aTotal;
  });

  const planId = typeof balances[0]?.plan_id === "string" ? balances[0].plan_id : null;
  return {
    server_time: serverTime,
    plan_id: planId,
    plan_label: deriveZcodePlanLabel(planId),
    buckets: sorted,
    primary_window: sorted[0]?.window || null,
    secondary_window: sorted[1]?.window || null,
  };
}

async function fetchZcodeBilling(apiKey, { fetchImpl = fetch, baseUrl, env } = {}) {
  const root = (baseUrl || resolveZcodeBillingBaseUrl(env)).replace(/\/$/, "");
  const res = await fetchImpl(`${root}/billing/balance`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error("Not authenticated with ZCode. Run `zcode` in Terminal to log in.");
  }
  if (!res.ok) {
    throw new Error(`ZCode billing API returned ${res.status}`);
  }
  return res.json();
}

async function fetchZcodeLimits({ home, env, fetchImpl = fetch } = {}) {
  if (!isZcodeInstalled({ home, env })) {
    return { configured: false };
  }
  const auth = loadZcodeApiKey({ home, env });
  if (!auth) {
    return { configured: false };
  }
  try {
    const body = await fetchZcodeBilling(auth.apiKey, {
      fetchImpl,
      // Coding-plan baseURL is ".../zcode-plan/anthropic"; strip the trailing
      // "/anthropic" (with or without a trailing slash) to reach the billing root.
      baseUrl: auth.baseUrl ? auth.baseUrl.replace(/\/anthropic\/?$/, "") : undefined,
      env,
    });
    const apiCode = typeof body?.code === "number" ? body.code : null;
    if (apiCode !== null && apiCode !== 0) {
      throw new Error(`ZCode billing API error: code=${apiCode} msg=${body?.msg || "unknown"}`);
    }
    return {
      configured: true,
      error: null,
      ...normalizeZcodeBalanceResponse(body),
    };
  } catch (error) {
    return {
      configured: true,
      error: error?.message || "Unknown error",
    };
  }
}

module.exports = {
  resolveZcodeHome,
  resolveZcodeBillingBaseUrl,
  isZcodeInstalled,
  loadZcodeApiKey,
  deriveZcodePlanLabel,
  normalizeZcodeBalanceResponse,
  fetchZcodeBilling,
  fetchZcodeLimits,
};
