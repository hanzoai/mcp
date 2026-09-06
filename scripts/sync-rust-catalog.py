#!/usr/bin/env python3
"""Copy cloud's generated catalog into the self-contained Rust crate."""
import argparse
from pathlib import Path

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--check", action="store_true")
args = parser.parse_args()
source = root / "src/tools/catalog.json"
destination = root / "rust/catalog.json"
if args.check:
    if not destination.exists() or destination.read_bytes() != source.read_bytes():
        raise SystemExit("Rust catalog drift: run python3 scripts/sync-rust-catalog.py")
else:
    destination.write_bytes(source.read_bytes())
