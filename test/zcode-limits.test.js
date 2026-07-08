const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  deriveZcodePlanLabel,
  normalizeZcodeBalanceResponse,
  loadZcodeCredential,
  loadLatestZcodeBalanceFromLogs,
  loadZcodeAuthCandidates,
  loadZcodeApiKey,
  fetchZcodeLimits,
  isZcodeInstalled,
  resolveZcodeAppVersion,
  resolveZcodeProviderBillingBaseUrl,
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

function zcodeCredentialSecret(home) {
  return `zcode-credential-fallback:${process.platform}:${home}:${os.userInfo().username || ""}`;
}

function encryptZcodeCredentialValue(value, home) {
  const iv = Buffer.alloc(12, 7);
  const key = crypto.createHash("sha256").update(zcodeCredentialSecret(home)).digest();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

function writeZcodeCredentials(v2, home, values) {
  const encrypted = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, encryptZcodeCredentialValue(value, home)]),
  );
  fs.writeFileSync(path.join(v2, "credentials.json"), JSON.stringify(encrypted), "utf8");
}

function writeZcodeBalanceLog(v2, timestamp, { providerId = "builtin:zai-start-plan", body = balanceBody() } = {}) {
  const logsDir = path.join(v2, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const day = timestamp.slice(0, 10);
  const entry = {
    balanceCount: body.data.balances.length,
    balances: body.data.balances,
    code: 0,
    msg: "",
    payload: body,
    providerId,
    success: true,
    url: "https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.2.5",
  };
  fs.writeFileSync(
    path.join(logsDir, `${day}.log`),
    `[${timestamp}] [info] [pid:1] [main] [host-log] [usage-stats] billing/balance 请求完成 ${JSON.stringify(entry)}\n`,
    "utf8",
  );
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
  it("throws on missing data", () => {
    assert.throws(() => normalizeZcodeBalanceResponse({}), /missing data/);
  });
  it("treats an empty balance list as connected with no windows", () => {
    const r = normalizeZcodeBalanceResponse({ data: { server_time: 1783431521, balances: [] } });
    assert.equal(r.server_time, 1783431521);
    assert.deepEqual(r.buckets, []);
    assert.equal(r.primary_window, null);
    assert.equal(r.secondary_window, null);
  });
});

describe("resolveZcodeAppVersion", () => {
  it("prefers the explicit app version env override", () => {
    assert.equal(
      resolveZcodeAppVersion({ env: { TOKENTRACKER_ZCODE_APP_VERSION: "9.8.7" } }),
      "9.8.7",
    );
  });
  it("reads the app version from a configured ZCode.app plist", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-app-"));
    try {
      const app = path.join(tmp, "ZCode.app");
      const contents = path.join(app, "Contents");
      fs.mkdirSync(contents, { recursive: true });
      fs.writeFileSync(
        path.join(contents, "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleShortVersionString</key>
  <string>3.2.5</string>
</dict>
</plist>`,
        "utf8",
      );
      assert.equal(
        resolveZcodeAppVersion({ env: { TOKENTRACKER_ZCODE_APP_PATH: app } }),
        "3.2.5",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("loadZcodeApiKey", () => {
  it("maps all built-in ZCode plan providers to the zcode-plan billing root", () => {
    for (const key of [
      "builtin:bigmodel-start-plan",
      "builtin:zai-start-plan",
      "builtin:bigmodel-coding-plan",
      "builtin:zai-coding-plan",
    ]) {
      assert.equal(
        resolveZcodeProviderBillingBaseUrl(key, { options: { baseURL: "https://api.z.ai/api/anthropic" } }, {}),
        "https://zcode.z.ai/api/v1/zcode-plan",
      );
    }
  });

  it("prefers the provider ZCode marked available in coding-plan-cache", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-available-key-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      fs.writeFileSync(
        path.join(v2, "config.json"),
        JSON.stringify({
          provider: {
            "builtin:bigmodel-start-plan": {
              enabled: true,
              options: { apiKey: "stale-bigmodel-key", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
            },
            "builtin:zai-start-plan": {
              enabled: true,
              options: { apiKey: "live-zai-key", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
            },
          },
        }),
        "utf8",
      );
      fs.writeFileSync(
        path.join(v2, "coding-plan-cache.json"),
        JSON.stringify({
          entryStatus: {
            items: {
              "builtin:bigmodel-start-plan": { status: "unavailable", reason: "coding_plan_not_authenticated" },
              "builtin:zai-start-plan": { status: "available" },
            },
          },
        }),
        "utf8",
      );
      const auth = loadZcodeApiKey({ home: tmp });
      assert.equal(auth.providerKey, "builtin:zai-start-plan");
      assert.equal(auth.apiKey, "live-zai-key");
      assert.equal(auth.billingBaseUrl, "https://zcode.z.ai/api/v1/zcode-plan");
      assert.deepEqual(loadZcodeAuthCandidates({ home: tmp }).map((a) => a.providerKey), ["builtin:zai-start-plan"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prefers ZCode's active-provider credential token before the config apiKey for start plan auth", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-credential-key-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      fs.writeFileSync(
        path.join(v2, "config.json"),
        JSON.stringify({
          provider: {
            "builtin:zai-start-plan": {
              enabled: true,
              options: { apiKey: "config-token", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
            },
          },
        }),
        "utf8",
      );
      writeZcodeCredentials(v2, tmp, {
        "oauth:active_provider": "zai",
        zcodejwttoken: "credential-token",
      });

      assert.equal(loadZcodeCredential("oauth:active_provider", { home: tmp }), "zai");
      const auths = loadZcodeAuthCandidates({ home: tmp });
      assert.equal(auths[0].apiKey, "credential-token");
      assert.equal(auths[0].auth_source, "credential:zcodejwttoken");
      assert.equal(auths[1].apiKey, "config-token");
      assert.equal(auths[1].auth_source, "provider:config");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not use the shared ZCode JWT for the wrong regional start-plan provider", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-credential-region-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      fs.writeFileSync(
        path.join(v2, "config.json"),
        JSON.stringify({
          provider: {
            "builtin:zai-start-plan": {
              enabled: true,
              options: { apiKey: "config-token", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
            },
          },
        }),
        "utf8",
      );
      writeZcodeCredentials(v2, tmp, {
        "oauth:active_provider": "bigmodel",
        zcodejwttoken: "wrong-region-token",
      });

      const auths = loadZcodeAuthCandidates({ home: tmp });
      assert.equal(auths.length, 1);
      assert.equal(auths[0].apiKey, "config-token");
      assert.equal(auths[0].auth_source, "provider:config");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

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
  function writeZcodeConfig(tmp) {
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
    return v2;
  }

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
      writeZcodeConfig(tmp);
      const result = await fetchZcodeLimits({
        home: tmp,
        env: { TOKENTRACKER_ZCODE_APP_VERSION: "3.2.5" },
        fetchImpl: async (url, options) => {
          // baseURL's trailing /anthropic is stripped → billing/balance root
          assert.equal(url, "https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.2.5");
          assert.equal(options.headers.Authorization, "Bearer live-key");
          assert.equal(options.headers["User-Agent"], "ZCode/3.2.5");
          assert.equal(options.headers["X-ZCode-App-Version"], "3.2.5");
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

  it("tries the next regional provider when the first one returns 405", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-region-fallback-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      fs.writeFileSync(
        path.join(v2, "config.json"),
        JSON.stringify({
          provider: {
            "builtin:bigmodel-start-plan": {
              enabled: true,
              options: { apiKey: "bigmodel-key", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
            },
            "builtin:zai-start-plan": {
              enabled: true,
              options: { apiKey: "zai-key", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
            },
          },
        }),
        "utf8",
      );
      const seen = [];
      const result = await fetchZcodeLimits({
        home: tmp,
        env: { TOKENTRACKER_ZCODE_APP_VERSION: "3.2.5" },
        fetchImpl: async (url, options) => {
          seen.push(options.headers.Authorization);
          if (options.headers.Authorization === "Bearer bigmodel-key") {
            return { ok: false, status: 405, async json() { return { code: 3012, msg: "method not allowed" }; } };
          }
          assert.equal(options.headers.Authorization, "Bearer zai-key");
          assert.equal(url, "https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.2.5");
          return { ok: true, status: 200, async json() { return balanceBody(); } };
        },
      });
      assert.deepEqual(seen, ["Bearer bigmodel-key", "Bearer zai-key"]);
      assert.equal(result.error, null);
      assert.equal(result.provider_key, "builtin:zai-start-plan");
      assert.equal(result.primary_window.used_percent, 20);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("continues after an empty balance response when another provider has windows", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-empty-then-live-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      fs.writeFileSync(
        path.join(v2, "config.json"),
        JSON.stringify({
          provider: {
            "builtin:bigmodel-start-plan": {
              enabled: true,
              options: { apiKey: "bigmodel-key", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
            },
            "builtin:zai-start-plan": {
              enabled: true,
              options: { apiKey: "zai-key", baseURL: "https://zcode.z.ai/api/v1/zcode-plan/anthropic" },
            },
          },
        }),
        "utf8",
      );
      const result = await fetchZcodeLimits({
        home: tmp,
        env: { TOKENTRACKER_ZCODE_APP_VERSION: "3.2.5" },
        fetchImpl: async (_url, options) => {
          if (options.headers.Authorization === "Bearer bigmodel-key") {
            return {
              ok: true,
              status: 200,
              async json() { return { code: 0, msg: "", data: { server_time: 1783431521, balances: [] } }; },
            };
          }
          return { ok: true, status: 200, async json() { return balanceBody(); } };
        },
      });
      assert.equal(result.error, null);
      assert.equal(result.provider_key, "builtin:zai-start-plan");
      assert.equal(result.buckets.length, 2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("surfaces an auth error on 401 without throwing", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-401-"));
    try {
      writeZcodeConfig(tmp);
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

  it("falls back to ZCode's latest successful local billing log when the live API returns 405", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-log-fallback-"));
    try {
      const v2 = writeZcodeConfig(tmp);
      writeZcodeBalanceLog(v2, "2026-07-08 09:08:30.077");
      const result = await fetchZcodeLimits({
        home: tmp,
        env: { TOKENTRACKER_ZCODE_APP_VERSION: "3.2.5" },
        nowMs: new Date(2026, 6, 8, 9, 10, 0).getTime(),
        fetchImpl: async () => ({ ok: false, status: 405, async json() { return { code: 3012, msg: "method not allowed" }; } }),
      });
      assert.equal(result.configured, true);
      assert.equal(result.error, null);
      assert.equal(result.source, "zcode-log");
      assert.equal(result.provider_key, "builtin:zai-start-plan");
      assert.equal(result.log_timestamp, new Date(2026, 6, 8, 9, 8, 30, 77).toISOString());
      assert.equal(result.primary_window.used_percent, 20);
      assert.match(result.provider_errors[0], /405/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ignores stale ZCode billing logs instead of hiding the live API failure forever", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-stale-log-"));
    try {
      const v2 = writeZcodeConfig(tmp);
      writeZcodeBalanceLog(v2, "2026-07-08 09:08:30.077");
      const result = await fetchZcodeLimits({
        home: tmp,
        env: { TOKENTRACKER_ZCODE_APP_VERSION: "3.2.5" },
        nowMs: new Date(2026, 6, 8, 16, 0, 0).getTime(),
        fetchImpl: async () => ({ ok: false, status: 405, async json() { return { code: 3012, msg: "method not allowed" }; } }),
      });
      assert.equal(result.configured, true);
      assert.match(result.error, /405/);
      assert.equal(result.source, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("can read the latest successful balance directly from ZCode logs", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-read-log-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      writeZcodeBalanceLog(v2, "2026-07-08 09:08:30.077");
      const record = loadLatestZcodeBalanceFromLogs({
        home: tmp,
        providerKeys: ["builtin:zai-start-plan"],
        nowMs: new Date(2026, 6, 8, 9, 9, 0).getTime(),
      });
      assert.equal(record.providerKey, "builtin:zai-start-plan");
      assert.equal(record.body.code, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses the zcode-plan billing root for coding-plan providers with generic model base URLs", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-zcode-coding-provider-"));
    try {
      const v2 = path.join(tmp, ".zcode", "v2");
      fs.mkdirSync(v2, { recursive: true });
      fs.writeFileSync(
        path.join(v2, "config.json"),
        JSON.stringify({
          provider: {
            "builtin:zai-coding-plan": {
              enabled: true,
              options: { apiKey: "gateway-key", baseURL: "https://api.z.ai/api/anthropic" },
            },
          },
        }),
        "utf8",
      );
      const auth = loadZcodeApiKey({ home: tmp });
      assert.equal(auth.providerKey, "builtin:zai-coding-plan");
      assert.equal(auth.billingBaseUrl, "https://zcode.z.ai/api/v1/zcode-plan");
      const result = await fetchZcodeLimits({
        home: tmp,
        env: { TOKENTRACKER_ZCODE_APP_VERSION: "3.2.5" },
        fetchImpl: async (url, options) => {
          assert.equal(url, "https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.2.5");
          assert.equal(options.headers.Authorization, "Bearer gateway-key");
          return { ok: true, status: 200, async json() { return balanceBody(); } };
        },
      });
      assert.equal(result.configured, true);
      assert.equal(result.error, null);
      assert.equal(result.plan_label, "Start");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
