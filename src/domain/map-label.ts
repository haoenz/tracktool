const preferredNames = [
  "name:zh-Hans",
  "name:zh",
  "name:zh-Hant",
  "name",
  "name:en",
  "name:latin",
];
const chineseName =
  /^[\p{Script=Han}\p{Mark}\p{Number}\s·・（）()「」『』“”‘’\-]+$/u;

function alternatives(
  value: string,
  languageNames: Set<string>,
  chinese: boolean,
): string[] {
  const names: string[] = [];
  let part = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    // OSM uses doubled semicolons for a literal semicolon in a name.
    if (char === ";" && value[i + 1] === ";") {
      part += ";";
      i++;
    } else if (";；\r\n".includes(char)) {
      names.push(part.trim());
      part = "";
    } else part += char;
  }
  names.push(part.trim());
  return names.filter(Boolean).flatMap((name) => {
    const parts = name.split(/[/／]/u).map((part) => part.trim());
    // Slashes can belong to a name. Split only Chinese alternatives or a
    // bilingual value corroborated by an independent language-specific tag.
    const isList =
      parts.length > 1 &&
      parts.every(Boolean) &&
      ((chinese &&
        parts.every(
          (part) => chineseName.test(part) && /\p{Script=Han}/u.test(part),
        )) ||
        parts.some((part) => languageNames.has(part)));
    return isList ? parts : [name];
  });
}

export function mapLabel(properties: Record<string, unknown>): string {
  const languageNames = new Set(
    Object.entries(properties)
      .filter(
        ([key, value]) => key.startsWith("name:") && typeof value === "string",
      )
      .map(([, value]) => (value as string).trim())
      .filter(Boolean),
  );
  const candidates = preferredNames.flatMap((key) => {
    const value = properties[key];
    if (typeof value !== "string") return [];
    const names = alternatives(value, languageNames, key.startsWith("name:zh"));
    return names.length ? [names] : [];
  });
  // Prefer an intact name in any supported language over truncating a list.
  return (
    candidates.find((names) => names.length === 1)?.[0] ??
    candidates[0]?.[0] ??
    ""
  );
}
