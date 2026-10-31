import type { ExpressionSpecification } from "maplibre-gl";

/** Convert screen zoom bands to the oversized preview canvas's zoom levels. */
export function labelZoom(min: number, max: number | undefined, offset = 0) {
  const minzoom = min === 0 ? 0 : Math.max(0, Math.min(24, min - offset));
  const maxzoom =
    max === undefined ? undefined : Math.max(0, Math.min(24, max - offset));
  const stops: number[] = min === 0 ? [0, 1] : [minzoom, 0, minzoom + 0.5, 1];
  if (maxzoom !== undefined) stops.push(maxzoom - 0.5, 1, maxzoom, 0);
  return {
    minzoom,
    ...(maxzoom === undefined ? {} : { maxzoom }),
    opacity:
      min === 0 && max === undefined
        ? 1
        : ([
            "interpolate",
            ["linear"],
            ["zoom"],
            ...stops,
          ] as ExpressionSpecification),
  };
}
