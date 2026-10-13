"""Rebuild the shipped, attributed city snapshot from an explicitly downloaded CN.zip."""

import argparse
from pathlib import Path

from tracktool.drawing.gazetteer import write_gazetteer

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("source", type=Path)
parser.add_argument("destination", type=Path)
args = parser.parse_args()
write_gazetteer(args.source, args.destination)
