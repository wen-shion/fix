const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  deriveZcodePlanLabel,
  normalizeZcodeBalanceResponse,
  loadZcodeApiKey,
  fetchZcodeLimits,
  isZcodeInstalled,
} = require("../src/lib/zcode-limits");

// Real billing/balance payload shape captured from ZCode's own logs.
function balanceBody() {
  return {
    code: 0,
    msg: "",
    data: {
      server_time: 1782188525,
      balances: [
        {
          plan_id: "zcode-v3-start-plan-0615",
          entitlement_id: "ent_start_public_glm_5p2",
          show_name: "GLM-5.2",
          total_units: 3_000_000,
          used_units: 600_000,
          remaining_units: 2_400_000,
          period_end: 1782230399,
          expires_at: 1782230399,
        },
        {
          plan_id: "zcode-v3-start-plan-0615",
          entitlement_id: "ent_start_public_glm_5turbo",
          show_name: "GLM-5-Turbo",
          total_units: 2_000_000,
          used_units: 0,
          remaining_units: 2_000_000,
          period_end: 1782230399,
          expires_at: 1782230399,
        },
      ],
    },
  };
}

describe("deriveZcodePlanLabel", () => {
  it("extracts the human tier from the raw plan id", () => {
    assert.equal(deriveZcodePlanLabel("zcode-v3-start-plan-0615"), "Start");
    assert.equal(deriveZcodePlanLabel("zcode-v3-pro-plan-0701"), "Pro");
    assert.equal(deriveZcodePlanLabel("zcode-v3-max-plan-0701"), "Max");
  });
  it("returns null for unknown / missing plan ids", () => {
    assert.equal(deriveZcodePlanLabel("zcode-v3-unknown-0615"), null);
    assert.equal(deriveZcodePlanLabel(""), null);
    assert.equal(deriveZcodePlanLabel(null), null);
  });
});

describe("normalizeZcodeBalanceResponse", () => {
  it("maps each model balance to a window with used_percent + reset, sorted by total", () => {
    const r = normalizeZcodeBalanceResponse(balanceBody());
    assert.equal(r.plan_id, "zcode-v3-start-plan-0615");
    assert.equal(r.plan_label, "Start");
    assert.equal(r.buckets.length, 2);
    // GLM-5.2 (3M) sorts before GLM-5-Turbo (2M)
    assert.equal(r.buckets[0].show_name, "GLM-5.2");
    assert.deepEqual(r.primary_window, {
      used_percent: 20, // 600k / 3M
      reset_at: "2026-06-23T15:59:59.000Z",
    });
    assert.deepEqual(r.secondary_window, {
      used_percent: 0,
      reset_at: "2026-06-23T15:59:59.000Z",
    });
  });
  it("throws on missing data / empty balances", () => {
    assert.throws(() => normalizeZcodeBalanceResponse({}), /missing data/);
    assert.throws(() => normalizeZcodeBalanceResponse({ data: { balances: [] } }), /no balance buckets/);
  });
});

describe("loadZcodeApiKey", () => {
  it("picks the first enabled provider with a non-empty apiKey, skipping disabled/empty", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-key-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      fs.writeFileSync(
        path.join(v2, "config.json"),
        JSON.stringify({
          provider: {
            // disabled provider with a key — must be skipped
            "builtin:zai-coding-plan": { enabled: false, options: { apiKey: "leaked-key" } },
            // active start-plan with a refreshed key — must win
            "builtin:bigmodel-start-plan": {
              enabled: true,
              options: { apiKey: "live-key", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
            },
          },
        }),
        "utf8",
      );
      const auth = loadZcodeApiKey({ home: tmp });
      assert.equal(auth.providerKey, "builtin:bigmodel-start-plan");
      assert.equal(auth.apiKey, "live-key");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  it("returns null when no provider has a usable key", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-nokey-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      fs.writeFileSync(
        path.join(v2, "config.json"),
        JSON.stringify({ provider: { "builtin:zai-start-plan": { enabled: true, options: { apiKey: "" } } } }),
        "utf8",
      );
      assert.equal(loadZcodeApiKey({ home: tmp }), null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("fetchZcodeLimits", () => {
  it("returns configured:false when ZCode is not installed", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-missing-"));
    try {
      assert.equal(isZcodeInstalled({ home: tmp }), false);
      assert.deepEqual(await fetchZcodeLimits({ home: tmp }), { configured: false });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fetches billing/balance with the stored key and normalizes the windows", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-fetch-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      fs.writeFileSync(
        path.join(v2, "config.json"),
        JSON.stringify({
          provider: {
            "builtin:bigmodel-start-plan": {
              enabled: true,
              options: { apiKey: "live-key", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
            },
          },
        }),
        "utf8",
      );
      const result = await fetchZcodeLimits({
        home: tmp,
        fetchImpl: async (url, options) => {
          // baseURL's trailing /anthropic is stripped → billing/balance root
          assert.equal(url, "https://zcode.z.ai/api/v1/zcode-plan/billing/balance");
          assert.equal(options.headers.Authorization, "Bearer live-key");
          return { ok: true, status: 200, async json() { return balanceBody(); } };
        },
      });
      assert.equal(result.configured, true);
      assert.equal(result.error, null);
      assert.equal(result.plan_label, "Start");
      assert.equal(result.primary_window.used_percent, 20);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("surfaces an auth error on 401 without throwing", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-401-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      fs.writeFileSync(
        path.join(v2, "config.json"),
        JSON.stringify({ provider: { "builtin:bigmodel-start-plan": { enabled: true, options: { apiKey: "k" } } } }),
        "utf8",
      );
      const result = await fetchZcodeLimits({
        home: tmp,
        fetchImpl: async () => ({ ok: false, status: 401, async json() { return {}; } }),
      });
      assert.equal(result.configured, true);
      assert.match(result.error, /Not authenticated/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
