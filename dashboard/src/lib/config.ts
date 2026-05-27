import { getInsforgeRemoteUrl } from "./insforge-config";

export const STATUSPAGE_URL = "https://tokentracker.statuspage.io/";

/**
 * 仪表盘/用量等：本地 localhost 一律用空字符串（相对路径走 CLI 内置 API），不访问云端。
 */
export function getBackendBaseUrl() {
  const isLocalhost =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  if (isLocalhost) return "";

  // Non-localhost (tokentracker.cc): dashboard usage data comes from the
  // cloud. Delegate to getInsforgeRemoteUrl so the hardcoded prod fallback
  // applies when VITE_* env wasn't injected at build time — otherwise this
  // returned "" and usage API calls hit the Vercel host (no edge functions
  // there) → 404 → an empty dashboard after login.
  const env = typeof import.meta !== "undefined" ? import.meta.env : undefined;
  return (
    env?.VITE_TOKENTRACKER_BACKEND_BASE_URL ||
    env?.VITE_INSFORGE_BASE_URL ||
    getInsforgeRemoteUrl()
  ).trim();
}

/**
 * 排行榜专用：`tokentracker-leaderboard`、公开可见性等 InsForge Edge Functions。
 * 与 `getInsforgeBaseUrl()` 相同；在 localhost 只要配置了 `VITE_INSFORGE_BASE_URL` 仍会请求云端。
 */
export function getLeaderboardBaseUrl() {
  return getInsforgeRemoteUrl();
}
