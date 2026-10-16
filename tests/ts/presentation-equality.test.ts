import { expect, test } from "vitest";
import { samePresentation } from "../../src/shared/presentation-equality.js";
import type { Presentation } from "../../src/shared/track-edit.js";

const base: Presentation = {
  schema: 1,
  order: ["a", "b", "c"],
  ignored: [],
  default_connect: false,
  connections: [],
};

test("restoring a connection clears dirty state for either default", () => {
  for (const connected of [false, true]) {
    const original = { ...base, default_connect: connected };
    expect(
      samePresentation(original, {
        ...original,
        connections: [{ from: "a", to: "b", connect: !connected }],
      }),
    ).toBe(false);
    expect(
      samePresentation(original, {
        ...original,
        connections: [{ from: "a", to: "b", connect: connected }],
      }),
    ).toBe(true);
  }
});

test("batch connections and visibility compare by their effective state", () => {
  expect(
    samePresentation(
      { ...base, default_connect: true },
      {
        ...base,
        connections: [
          { from: "b", to: "c", connect: true },
          { from: "a", to: "b", connect: true },
        ],
      },
    ),
  ).toBe(true);
  expect(samePresentation(base, { ...base, ignored: ["b"] })).toBe(false);
  expect(
    samePresentation(
      { ...base, ignored: ["b", "c"] },
      {
        ...base,
        ignored: ["c", "b"],
      },
    ),
  ).toBe(true);
  expect(samePresentation(base, { ...base, order: ["b", "a", "c"] })).toBe(
    false,
  );
});

test("connections on hidden segments still count as edits", () => {
  const hidden = { ...base, ignored: ["b"] };
  expect(
    samePresentation(hidden, {
      ...hidden,
      connections: [{ from: "a", to: "b", connect: true }],
    }),
  ).toBe(false);
});
