import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from adas.catalog import CATALOG

REPO_ROOT = Path(__file__).resolve().parents[3]


def _ts_entries() -> dict[str, dict[str, str]]:
    catalog_path = REPO_ROOT / "shared" / "adas.ts"
    if not catalog_path.exists():
        pytest.skip("shared/adas.ts not present (running outside a full checkout)")
    source = catalog_path.read_text(encoding="utf-8")
    entries: dict[str, dict[str, str]] = {}
    for block in re.finditer(r"\{\s*threat:\s*\"([a-z_]+)\"(.*?)\}", source, re.S):
        threat, body = block.group(1), block.group(2)
        fields = dict(re.findall(r"(\w+):\s*\"([^\"]*)\"", body))
        entries[threat] = fields
    return entries


def test_catalog_matches_the_typescript_strings_exactly():
    ts = _ts_entries()
    for threat, entry in CATALOG.items():
        assert threat in ts, f"{threat} missing from shared/adas.ts"
        for field in ("direction", "label", "message", "advice"):
            assert entry[field] == ts[threat][field], (
                f"{threat}.{field} drifted:\n"
                f"  catalog.py : {entry[field]}\n"
                f"  adas.ts    : {ts[threat][field]}"
            )
