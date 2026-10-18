import { setImmediate } from "node:timers/promises";
import sharp from "sharp";
import { displayCoordinate } from "../../shared/coordinates.js";

export const rasterReprojectionVersion = "gcj02-wgs84-v1";

/** Inverse mapping uses the forward WGS84 → GCJ02 transform, avoiding holes. */
export async function reprojectGcjTile(
  z: number,
  x: number,
  y: number,
  size: number,
  load: (x: number, y: number) => Promise<Buffer>,
): Promise<Buffer> {
  const count = 2 ** z,
    world = count * size;
  const positions = new Float64Array(size * size * 2);
  const needed = new Set<string>();
  const wrap = (n: number) => ((n % world) + world) % world;
  const snap = (n: number) =>
    Math.abs(n - Math.round(n)) < 1e-7 ? Math.round(n) : n;
  const key = (px: number, py: number) =>
    `${Math.floor(wrap(px) / size)},${Math.floor(py / size)}`;
  let unchanged = true;
  for (let row = 0; row < size; row++) {
    const lat =
      (Math.atan(
        Math.sinh(Math.PI * (1 - (2 * (y * size + row + 0.5)) / world)),
      ) *
        180) /
      Math.PI;
    for (let col = 0; col < size; col++) {
      const lon = ((x * size + col + 0.5) / world) * 360 - 180;
      const [lng, latitude] = displayCoordinate([lon, lat], "gcj02");
      const px = snap(((lng + 180) / 360) * world - 0.5);
      const py = snap(
        ((1 - Math.asinh(Math.tan((latitude * Math.PI) / 180)) / Math.PI) / 2) *
          world -
          0.5,
      );
      const index = (row * size + col) * 2;
      positions[index] = px;
      positions[index + 1] = py;
      unchanged &&= px === x * size + col && py === y * size + row;
      for (const sy of new Set([Math.floor(py), Math.ceil(py)]))
        for (const sx of new Set([Math.floor(px), Math.ceil(px)]))
          if (sy >= 0 && sy < world) needed.add(key(sx, sy));
    }
    // Keep request cancellation and other HTTP work responsive during CPU work.
    if (row % 16 === 15) await setImmediate();
  }
  if (unchanged)
    return sharp(await load(x, y))
      .png()
      .toBuffer();
  const images = new Map<string, Buffer>();
  await Promise.all(
    [...needed].map(async (id) => {
      const [tx, ty] = id.split(",").map(Number);
      const image = await sharp(await load(tx!, ty!))
        .toColourspace("srgb")
        .ensureAlpha()
        .raw()
        .toBuffer();
      images.set(id, image);
    }),
  );
  const output = Buffer.alloc(size * size * 4);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const index = row * size + col;
      const px = positions[index * 2]!,
        py = positions[index * 2 + 1]!;
      const left = Math.floor(px),
        top = Math.floor(py),
        dx = px - left,
        dy = py - top;
      let alpha = 0,
        red = 0,
        green = 0,
        blue = 0;
      for (let oy = 0; oy < 2; oy++) {
        const sy = top + oy;
        if (sy < 0 || sy >= world) continue;
        for (let ox = 0; ox < 2; ox++) {
          const weight = (ox ? dx : 1 - dx) * (oy ? dy : 1 - dy);
          if (!weight) continue;
          const sx = wrap(left + ox),
            data = images.get(key(sx, sy))!;
          const offset = ((sy % size) * size + (sx % size)) * 4;
          // Premultiplied interpolation prevents dark fringes around transparent labels.
          const a = data[offset + 3]! * weight;
          alpha += a;
          red += data[offset]! * a;
          green += data[offset + 1]! * a;
          blue += data[offset + 2]! * a;
        }
      }
      if (alpha) {
        output[index * 4] = Math.round(red / alpha);
        output[index * 4 + 1] = Math.round(green / alpha);
        output[index * 4 + 2] = Math.round(blue / alpha);
        output[index * 4 + 3] = Math.round(alpha);
      }
    }
    if (row % 16 === 15) await setImmediate();
  }
  return sharp(output, { raw: { width: size, height: size, channels: 4 } })
    .png()
    .toBuffer();
}
