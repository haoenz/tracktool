import { XmlDocument, XmlElement, ParseOption } from "libxml2-wasm";
import { AppError } from "../../domain/errors.js";
import type { XmlOperation, XmlResult } from "../../services/ports.js";

export const namespaces = {
  kml: "http://www.opengis.net/kml/2.2",
  gx: "http://www.google.com/kml/ext/2.2",
};
/** XPath 1.0 has no escaping; never interpolate an unquoted input into an expression. */
export function xpathLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat(${value
    .split("'")
    .map((part) => `'${part}'`)
    .join(', "\'", ')})`;
}
/** Documents and nodes must never escape this synchronous scope. Import/initialization occurs in a worker. */
export function withDocument<T>(
  bytes: Uint8Array,
  action: (doc: XmlDocument) => T,
): T {
  let doc: XmlDocument;
  try {
    doc = XmlDocument.fromBuffer(bytes, {
      option: ParseOption.XML_PARSE_NO_XXE | ParseOption.XML_PARSE_NONET,
    });
  } catch (cause) {
    throw new AppError("USER_INPUT", "XML 格式或编码无效", { cause });
  }
  try {
    return action(doc);
  } finally {
    doc.dispose();
  }
}
export function executeXml(
  bytes: Uint8Array,
  operation: Exclude<
    XmlOperation,
    { kind: "tracks" | "content" | "edit" | "segment-edit" }
  >,
): XmlResult {
  return withDocument(bytes, (doc) => {
    const name = doc.get("/kml:kml/kml:Document/kml:name", namespaces);
    if (operation.kind === "rename") {
      if (!(name instanceof XmlElement))
        throw new AppError("USER_INPUT", "KML 缺少 Document/name");
      // Replace every child, including mixed text/CDATA; text creation handles XML escaping.
      while (name.firstChild) name.firstChild.remove();
      name.addText(operation.name);
    }
    return {
      name: name?.content ?? "",
      placemarks: doc.find("//kml:Placemark", namespaces).length,
      coordinateNodes: doc.find("//kml:coordinates | //gx:coord", namespaces)
        .length,
      ...(operation.kind === "rename"
        ? { xml: doc.toString({ encoding: "utf-8" }) }
        : {}),
    };
  });
}
