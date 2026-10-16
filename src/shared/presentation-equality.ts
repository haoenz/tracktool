import type { Presentation } from "./track-edit.js";

// Compare effective connections, including hidden segments so their edits survive.
function connectionKeys(settings: Presentation): string[] {
  const edges = new Set<string>();
  if (settings.default_connect) {
    for (let i = 1; i < settings.order.length; i++) {
      edges.add(JSON.stringify([settings.order[i - 1], settings.order[i]]));
    }
  }
  for (const { from, to, connect } of settings.connections) {
    const key = JSON.stringify([from, to]);
    if (connect) edges.add(key);
    else edges.delete(key);
  }
  return [...edges].sort();
}

export function samePresentation(a: Presentation, b: Presentation): boolean {
  return (
    JSON.stringify(a.order) === JSON.stringify(b.order) &&
    JSON.stringify([...a.ignored].sort()) ===
      JSON.stringify([...b.ignored].sort()) &&
    JSON.stringify(connectionKeys(a)) === JSON.stringify(connectionKeys(b))
  );
}
