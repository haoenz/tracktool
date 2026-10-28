import { describe, expect, it } from "vitest";
import { compositionPadding, trackBounds } from "../../src/drawing/viewport.js";

describe("print composition bounds", () => {
  it("keeps a date-line crossing in a narrow longitude interval", () => {
    const bounds = trackBounds([
      [179, 25],
      [-179, 27],
      [178.5, 26],
    ])!;
    expect(bounds).toEqual([
      [178.5, 25],
      [181, 27],
    ]);
    expect(bounds[1][0] - bounds[0][0]).toBeLessThan(3);
  });

  it("preserves ordinary western longitudes and single-point tracks", () => {
    expect(
      trackBounds([
        [-123, 40],
        [-121, 38],
      ]),
    ).toEqual([
      [-123, 38],
      [-121, 40],
    ]);
    expect(trackBounds([[120, 30]])).toEqual([
      [120, 30],
      [120, 30],
    ]);
    expect(trackBounds([])).toBeUndefined();
  });

  it("reserves title and wrapped credits within the output frame", () => {
    expect(compositionPadding({ x: 0, y: 0 }, true, 72)).toEqual({
      top: 90,
      bottom: 96,
      left: 55,
      right: 55,
    });
  });

  it("keeps the same output insets while the map surroundings are visible", () => {
    const plain = compositionPadding({ x: 0, y: 0 }, false, 16);
    const surround = compositionPadding({ x: 240, y: 90 }, false, 16);
    expect(surround.left - 240).toBe(plain.left);
    expect(surround.right - 240).toBe(plain.right);
    expect(surround.top - 90).toBe(plain.top);
    expect(surround.bottom - 90).toBe(plain.bottom);
    expect(plain).toEqual({ top: 55, bottom: 55, left: 55, right: 55 });
  });
});
