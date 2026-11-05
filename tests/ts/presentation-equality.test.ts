import { expect, test } from "vitest";
import { samePresentation } from "../../src/shared/presentation-equality.js";
import type { Presentation } from "../../src/shared/track-edit.js";

const base: Presentation = {
  schema: 1,
  order: ["a", "b", "c"],
  ignored: [],
  gaps: [],
};
test("classification is an edit even when both states hide the connection", () => {
  const classified: Presentation = {
    ...base,
    gaps: [{ from: "a", to: "b", reason: "other" }],
  };
  expect(samePresentation(base, classified)).toBe(false);
  expect(
    samePresentation(classified, {
      ...classified,
      gaps: [{ from: "a", to: "b", reason: "tunnel" }],
    }),
  ).toBe(false);
  expect(samePresentation(base, { ...classified, gaps: [] })).toBe(true);
});
test("annotation order and ignored order do not change a snapshot", () => {
  const original: Presentation = {
    ...base,
    ignored: ["a", "b"],
    gaps: [
      { from: "a", to: "b", reason: "tunnel" },
      { from: "b", to: "c", reason: "other" },
    ],
  };
  expect(
    samePresentation(original, {
      ...original,
      ignored: ["b", "a"],
      gaps: [...original.gaps].reverse(),
    }),
  ).toBe(true);
  expect(samePresentation(original, { ...original, gaps: [] })).toBe(false);
  expect(samePresentation(base, { ...base, order: ["b", "a", "c"] })).toBe(
    false,
  );
});
