import React, { useMemo } from "react";
import { Link } from "react-router-dom";
import { copy } from "../lib/copy";
import { useCurrency } from "../hooks/useCurrency.js";
import { useTheme } from "../hooks/useTheme.js";
import { ThemeToggle } from "../ui/foundation/ThemeToggle.jsx";
import { InsforgeUserHeaderControls } from "../components/InsforgeUserHeaderControls.jsx";
import { HeaderGithubStar } from "../ui/components/HeaderGithubStar.jsx";
import {
  ProfileContent,
  ProfileSkeleton,
  useLeaderboardProfileData,
} from "../components/leaderboard/LeaderboardProfileModal.jsx";

/**
 * Standalone, shareable per-user profile page at /u/:userId. Reuses the same
 * content + data hook as the leaderboard modal; renders inside a centered
 * card with its own page chrome instead of a dialog. Public profiles are
 * visible to anonymous visitors (the edge function gates per target).
 */
export function LeaderboardProfilePage({ auth, signedIn, sessionSoftExpired, userId }) {
  const { currency, rate } = useCurrency();
  const { theme, resolvedTheme, setTheme } = useTheme();

  const authTokenAllowed = signedIn && !sessionSoftExpired;
  const accessToken = useMemo(() => {
    if (!authTokenAllowed) return null;
    if (typeof auth === "function") return auth;
    if (typeof auth === "string") return auth;
    if (auth && typeof auth === "object") return auth;
    return null;
  }, [auth, authTokenAllowed]);

  const state = useLeaderboardProfileData({ userId, period: "total", accessToken });

  return (
    <div className="flex flex-col min-h-screen bg-oai-white dark:bg-oai-gray-950 text-oai-black dark:text-oai-white font-oai antialiased transition-colors duration-200">
      <header className="sticky top-0 z-50 bg-white/80 dark:bg-oai-gray-950/80 backdrop-blur-md border-b border-oai-gray-200 dark:border-oai-gray-900 transition-colors duration-200">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-5">
            <Link
              to="/"
              className="flex items-center gap-3 no-underline outline-none rounded focus-visible:ring-2 focus-visible:ring-oai-brand-500 transition-opacity hover:opacity-80"
            >
              <img src="/app-icon.png" alt="" width={24} height={24} className="rounded-md" />
              <span className="text-sm font-semibold tracking-wide text-oai-black dark:text-white uppercase">
                Token Tracker
              </span>
            </Link>
            <div className="hidden sm:block">
              <HeaderGithubStar />
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <Link
              to="/leaderboard"
              className="no-underline inline-flex items-center justify-center h-9 px-5 text-sm font-medium rounded-full shadow-sm ring-1 ring-oai-gray-200 dark:ring-white/10 bg-oai-gray-900 dark:bg-white text-white dark:text-oai-gray-900 hover:bg-oai-gray-800 dark:hover:bg-oai-gray-100 transition-colors"
            >
              {copy("leaderboard.profile.nav.back")}
            </Link>
            <ThemeToggle theme={theme} resolvedTheme={resolvedTheme} onSetTheme={setTheme} />
            <InsforgeUserHeaderControls />
          </div>
        </div>
      </header>

      <main className="flex-1 py-8 sm:py-12">
        <div className="mx-auto max-w-[600px] px-4 sm:px-0">
          <div className="rounded-2xl bg-white dark:bg-oai-gray-950 ring-1 ring-oai-gray-200 dark:ring-oai-gray-800 overflow-hidden shadow-sm">
            {state.loading && <ProfileSkeleton />}
            {!state.loading && state.error && (
              <div className="px-6 py-16 text-center">
                <p className="text-sm text-red-500 dark:text-red-400">
                  {copy("leaderboard.profile_modal.error")}
                </p>
              </div>
            )}
            {!state.loading && !state.error && !state.data && (
              <div className="px-6 py-16 text-center">
                <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">
                  {copy("leaderboard.profile_modal.empty")}
                </p>
              </div>
            )}
            {!state.loading && !state.error && state.data && (
              <ProfileContent data={state.data} currency={currency} rate={rate} />
            )}
          </div>
        </div>
      </main>

      <footer className="border-t border-oai-gray-200 dark:border-oai-gray-900 py-8 transition-colors duration-200">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 sm:px-6 text-sm text-oai-gray-400 dark:text-oai-gray-500">
          <p>{copy("landing.v2.footer.line")}</p>
          <Link
            to="/leaderboard"
            className="text-oai-gray-400 dark:text-oai-gray-500 hover:text-oai-black dark:hover:text-white transition-colors"
          >
            {copy("leaderboard.profile.nav.back")}
          </Link>
        </div>
      </footer>
    </div>
  );
}
