import React from "react";

/**
 * Single provider column header: brand icon + label from copy registry.
 */
export function LeaderboardProviderColumnHeader({ iconSrc, label }) {
  return (
    <span className="inline-flex items-center gap-3">
      {iconSrc ? (
        <img
          src={iconSrc}
          alt=""
          width={16}
          height={16}
          className={`h-4 w-4 shrink-0 object-contain opacity-90 ${
            iconSrc === "/brand-logos/cursor.svg" ? "dark:invert" : ""
          }`}
        />
      ) : null}
      <span className="whitespace-nowrap">{label}</span>
    </span>
  );
}
