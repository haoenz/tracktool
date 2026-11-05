import { AppError } from "./errors.js";
export function coordinate(text: string): [number, number] {
  const decimal = /^(-?\d+\.?\d*)\s*[,\s]\s*(-?\d+\.?\d*)$/.exec(text.trim());
  const dms =
    /^\s*(\d{1,2})\s*(?:deg|°)?\s*(\d{1,2})\s*'\s*(\d{1,2}(?:\.\d+)?)\s*"\s*([NS北南])\s*,?\s*(\d{1,3})\s*(?:deg|°)?\s*(\d{1,2})\s*'\s*(\d{1,2}(?:\.\d+)?)\s*"\s*([EW东西])\s*$/.exec(
      text,
    );
  let result: [number, number] | undefined;
  if (decimal) result = [+decimal[1]!, +decimal[2]!];
  if (dms)
    result = [
      (+dms[1]! + +dms[2]! / 60 + +dms[3]! / 3600) *
        (/[S南]/.test(dms[4]!) ? -1 : 1),
      (+dms[5]! + +dms[6]! / 60 + +dms[7]! / 3600) *
        (/[W西]/.test(dms[8]!) ? -1 : 1),
    ];
  if (!result || Math.abs(result[0]) > 90 || Math.abs(result[1]) > 180)
    throw new AppError("USER_INPUT", `Invalid coordinate: ${text}`);
  return result;
}
