import type { Presentation } from "./track-edit.js";

// Classification changes matter even when they do not change visible geometry.
function connectionKeys(settings: Presentation): string[] {
  return settings.gaps
    .map(({ from, to, reason }) => JSON.stringify([from, to, reason]))
    .sort();
}

export function samePresentation(a: Presentation, b: Presentation): boolean {
  return (
    JSON.stringify(a.order) === JSON.stringify(b.order) &&
    JSON.stringify([...a.ignored].sort()) ===
      JSON.stringify([...b.ignored].sort()) &&
    JSON.stringify(connectionKeys(a)) === JSON.stringify(connectionKeys(b))
  );
}
