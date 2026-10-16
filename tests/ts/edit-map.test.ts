import { expect, it } from "vitest";
import {
  nearestPoint,
  previewAnnotations,
} from "../../dist/node/shared/edit-map.js";
import type { EditPreview } from "../../dist/node/shared/track-edit.js";
it("picking uses original indices and the short longitude arc at the dateline", () => {
  expect(
    nearestPoint(
      [
        [179.9, 20],
        [-170, 20],
      ],
      [-179.95, 20],
    ),
  ).toBe(0);
  expect(
    nearestPoint(
      [
        [120, 30],
        [120.001, 30],
        [120.002, 30],
      ],
      [120.0011, 30],
    ),
  ).toBe(1);
  expect(nearestPoint([], [0, 0])).toBe(-1);
});
it("preview overlays preserve deleted coordinates and exact split positions", () => {
  const before = {
    segments: [
      {
        segment_id: "segment",
        coordinates: [
          [120, 30],
          [120.1, 30],
          [120.2, 30],
        ] as [number, number][],
      },
    ],
    connections: [],
  };
  const preview = {
    operation: {
      kind: "split_segment",
      segment_id: "segment",
      after_point_indices: [1],
    },
    changes: [
      { removed_ranges: [{ segment_id: "segment", start: 0, end: 1 }] },
    ],
  } as EditPreview;
  expect(previewAnnotations(before, preview)).toEqual([
    { segment_id: "ux-delete", coordinates: [[120, 30]] },
    { segment_id: "ux-break", coordinates: [[120.1, 30]] },
  ]);
  expect(before.segments[0]!.coordinates).toHaveLength(3);
});

it("draw preview marks new full-precision coordinates without changing the source", () => {
  const preview = {
    operation: {
      kind: "draw",
      coordinates: [
        [120.123456789, 30],
        [120.12345679, 30.1],
      ],
      after_segment_id: null,
    },
    changes: [],
  } as unknown as EditPreview;
  expect(
    previewAnnotations({ segments: [], connections: [] }, preview),
  ).toEqual([
    {
      segment_id: "ux-add",
      coordinates: [
        [120.123456789, 30],
        [120.12345679, 30.1],
      ],
    },
  ]);
});
