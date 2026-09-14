"""KML/XML helpers shared across the kml package.

lxml.etree provides namespace-aware in-place DOM editing with XPath.

KML namespaces used by 2bulu exports:
- kml: http://www.opengis.net/kml/2.2 (the document element's own namespace)
- gx: http://www.google.com/kml/ext/2.2 (Google extension: Track/coord/when)
"""

from pathlib import Path

from lxml import etree

from ..errors import UserInputError
from ..paths import display_path

KML_NS = "http://www.opengis.net/kml/2.2"
GX_NS = "http://www.google.com/kml/ext/2.2"

NSMAP = {"kml": KML_NS, "gx": GX_NS}


def parse_file(path: Path) -> etree._ElementTree:
    parser = etree.XMLParser(remove_blank_text=False, strip_cdata=False, recover=False)
    try:
        return etree.parse(str(path), parser)
    except (etree.XMLSyntaxError, OSError) as exc:
        raise UserInputError(f"Cannot read KML file {display_path(path)}: {exc}") from exc


def parse_string(text: str) -> etree._ElementTree:
    try:
        return etree.fromstring(text.encode("utf-8")).getroottree()
    except etree.XMLSyntaxError as exc:
        raise UserInputError(f"Cannot parse KML: {exc}") from exc


def save(tree: etree._ElementTree, path: Path) -> None:
    tree.write(str(path), encoding="UTF-8", xml_declaration=True)


def doc_ns(tree: etree._ElementTree) -> str:
    """The document element's actual namespace URI (usually KML_NS)."""
    return etree.QName(tree.getroot()).namespace or ""


def nsmap_for(tree: etree._ElementTree) -> dict[str, str]:
    """Prefix map for XPath: kml -> document namespace, gx -> Google ext."""
    return {"kml": doc_ns(tree), "gx": GX_NS}


def find(tree: etree._ElementTree, xpath: str) -> etree._Element | None:
    """First node matching an XPath (relative to document root)."""
    nodes = tree.xpath(xpath, namespaces=nsmap_for(tree))
    return nodes[0] if nodes else None


def findall(tree: etree._ElementTree, xpath: str) -> list[etree._Element]:
    return tree.xpath(xpath, namespaces=nsmap_for(tree))


def sub(parent: etree._Element, tag: str, text: str | None = None, ns: str | None = None) -> etree._Element:
    """Create and append a namespaced child element, optionally with text."""
    element = etree.SubElement(parent, f"{{{ns or doc_ns(parent.getroottree())}}}{tag}")
    if text is not None:
        element.text = text
    return element


def element_text(node: etree._Element | None) -> str:
    return (node.text or "").strip() if node is not None else ""


def extended_data_value(tree: etree._ElementTree, name: str) -> str:
    """Read Document/ExtendedData/Data[@name=...]/value text ('' when absent)."""
    node = find(tree, f"/kml:kml/kml:Document/kml:ExtendedData/kml:Data[@name='{name}']/kml:value")
    return element_text(node)
