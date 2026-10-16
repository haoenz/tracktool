import { useEffect, useState } from "react";

/** Optional per-tab state. Storage failure must never block the workspace. */
export function useSessionState<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const text = sessionStorage.getItem(key);
      return text ? (JSON.parse(text) as T) : fallback;
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode / quota */
    }
  }, [key, value]);
  return [value, setValue] as const;
}
