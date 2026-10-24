import { useEffect, useState } from "react";
import type { OverviewVisibility } from "./overview-layer.js";

/** Track visibility used when a browser tab opens the workspace. */
export type EntryVisibility = "all" | "none";

type Snapshot = { mode: EntryVisibility; visibility: OverviewVisibility };

const storageKey = "tracktool:entry-visibility";

export function readEntryVisibility(): EntryVisibility {
  try {
    if (localStorage.getItem(storageKey) === "none") return "none";
  } catch {
    // A browser that blocks storage still gets the default entry state.
  }
  return "all";
}

export function saveEntryVisibility(value: EntryVisibility) {
  try {
    localStorage.setItem(storageKey, value);
  } catch {
    // The choice still applies to this tab even without persistent storage.
  }
}

function initialVisibility(mode: EntryVisibility): OverviewVisibility {
  return { all: mode === "all", exceptions: {} };
}

/**
 * Visibility for the library layer. A tab snapshot is only reused while the
 * entry preference that produced it is unchanged, so a new preference wins
 * even when the browser copies session storage into the new tab.
 */
export function useEntryVisibility(key: string) {
  const [visibility, setVisibility] = useState<OverviewVisibility>(() => {
    const mode = readEntryVisibility();
    try {
      const text = sessionStorage.getItem(key);
      const stored = text ? (JSON.parse(text) as Partial<Snapshot>) : undefined;
      if (stored?.mode === mode && stored.visibility) return stored.visibility;
    } catch {
      // Unreadable snapshots fall back to the preference.
    }
    return initialVisibility(mode);
  });
  useEffect(() => {
    try {
      const snapshot: Snapshot = {
        mode: readEntryVisibility(),
        visibility,
      };
      sessionStorage.setItem(key, JSON.stringify(snapshot));
    } catch {
      /* private mode / quota */
    }
  }, [key, visibility]);
  return [visibility, setVisibility] as const;
}
