"""Shared helpers for the sap-abap-tdd pipeline scripts.

Every script here works on local files only. None of them talks to SAP: SAP is
reached exclusively through the agent's `adt` tool, and these scripts only
prepare the arguments for that tool and read back what it wrote to disk.

Python standard library only — the skill must run wherever the agent's bash runs,
without a pip install.
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
TEMPLATE_PATH = SKILL_DIR / "template" / "Technical_Document.html"

# Object types pulled into the snapshot. `--include-only` replaces the connection's
# pull-config entirely, so this is the complete list, not an addition.
#
# Data elements, domains and table types are left out on purpose: they are the bulk
# of a DDIC-heavy package, cost one HTTP round trip each against the 120 s cap, and
# the inventory still records their names and descriptions without fetching them.
# TRAN / MSAG / SUSH / TOBJ are added because the default pull-config skips them and
# they carry the entry points, the message concept and the authorization checks.
PULL_TYPES = [
    "CLAS/OC", "INTF/OI", "PROG/P", "PROG/I",
    "FUGR/F", "FUGR/FF", "FUGR/I",
    "TABL/DT", "TABL/DS", "VIEW/DV",
    "DDLS/DF", "DDLS/DL", "DCLS/DL",
    "MSAG/N", "TRAN/T", "TOBJ/TOB", "SUSH",
]

# Retry plan when a whole-package pull does not finish inside the 120 s cap.
PULL_TYPE_GROUPS = [
    ["CLAS/OC", "INTF/OI"],
    ["PROG/P", "PROG/I", "FUGR/F", "FUGR/FF", "FUGR/I"],
    ["TABL/DT", "TABL/DS", "VIEW/DV", "DDLS/DF", "DDLS/DL", "DCLS/DL"],
    ["MSAG/N", "TRAN/T", "TOBJ/TOB", "SUSH"],
]


class _Undefined:
    """JavaScript's `undefined`: a key that exists for ordering but is not serialized.

    facts.json was first produced by a JavaScript implementation, where
    `obj.x ??= value` creates the key even when `value` is undefined, and a later
    real assignment keeps that original key position. Emulating it keeps the output
    byte-identical to the reference implementation, which is how the port was verified.
    """

    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __bool__(self):
        return False

    def __repr__(self):
        return "UNDEF"


UNDEF = _Undefined()


def nullish(value) -> bool:
    return value is None or value is UNDEF


def coalesce(*values):
    """JavaScript `a ?? b ?? c`."""
    for v in values[:-1]:
        if not nullish(v):
            return v
    return values[-1]


def assign_nullish(d: dict, key: str, value) -> None:
    """JavaScript `d[key] ??= value` (creates the key even when value is UNDEF)."""
    if nullish(d.get(key, UNDEF)):
        d[key] = value


class OrderedSet:
    """Insertion-ordered set (JavaScript `Set`), serialized as a list."""

    def __init__(self, items=()):
        self._d = dict.fromkeys(items)

    def add(self, item):
        self._d[item] = None

    def __contains__(self, item):
        return item in self._d

    def __iter__(self):
        return iter(list(self._d))

    def __len__(self):
        return len(self._d)


def serial(value):
    """Ordered sets → lists, UNDEF dropped from dicts and turned into null in lists."""
    if isinstance(value, OrderedSet):
        return [serial(v) for v in value]
    if isinstance(value, dict):
        return {k: serial(v) for k, v in value.items() if v is not UNDEF}
    if isinstance(value, (list, tuple)):
        return [None if v is UNDEF else serial(v) for v in value]
    if isinstance(value, (set, frozenset)):
        raise TypeError("use OrderedSet instead of set for serialized values")
    if isinstance(value, Path):
        return str(value)
    return value


def js_str(value) -> str:
    """A value interpolated into a JavaScript template string."""
    if value is UNDEF:
        return "undefined"
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


_LOCALE_MAP = {ord("_"): "\x01", ord("-"): "\x02", ord("/"): "\x03"}


def locale_key(s) -> str:
    """Sort key close to JavaScript `localeCompare` (ICU root) for SAP names:
    punctuation before digits before letters, case-insensitive first."""
    return str(s).translate(_LOCALE_MAP).casefold()


def js_key_order(d: dict) -> dict:
    """Object key order as JavaScript keeps it: integer-like keys first, ascending."""
    ints = sorted((k for k in d if k.isdigit() and str(int(k)) == k and int(k) < 4294967295), key=int)
    rest = [k for k in d if k not in set(ints)]
    return {k: d[k] for k in ints + rest}


def parse_args(argv: list[str]) -> dict:
    out: dict = {"_": []}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("--"):
            key = a[2:]
            nxt = argv[i + 1] if i + 1 < len(argv) else None
            if nxt is None or nxt.startswith("--"):
                out[key] = True
            else:
                out[key] = nxt
                i += 1
        else:
            out["_"].append(a)
        i += 1
    return out


def safe_folder(name: str) -> str:
    """`/RB4R/FOO` → `#RB4R#FOO`, the folder spelling adt-cli and abapGit both use."""
    return re.sub(r'[\\:*?"<>|]', "_", str(name).upper().replace("/", "#"))


def namespace_of(name: str) -> str | None:
    """`/RB4R/FOO` → `rb4r`; plain Z/Y names have no namespace."""
    m = re.match(r"^/([^/]+)/", str(name))
    return m.group(1).lower() if m else None


def fwd(p) -> str:
    """Forward slashes only: argv values end up in JSON the model copies verbatim."""
    return str(p).replace("\\", "/")


def lp(p) -> str:
    """Path for file I/O that survives Windows' 260-character limit.

    A snapshot file sits ~240 characters deep on a real workspace
    (`...\\.scratchpad\\tdd\\#RB4R#PKG\\<run>\\src\\#RB4R#PKG\\rb4r\\x.fugr._rb4r_lx_uf00.abap`),
    and without LongPathsEnabled Python cannot open what adt-cli (Node, long-path aware)
    wrote there — and `exists()` just answers False, so the file silently drops out of
    the facts. The `\\\\?\\` prefix lifts the limit. Paths stored in facts stay unprefixed.
    """
    s = os.path.abspath(str(p))
    if os.name == "nt" and len(s) >= 240 and not s.startswith("\\\\?\\"):
        return "\\\\?\\" + s
    return s


_MISSING = object()


def read_json(file, fallback=_MISSING):
    try:
        with open(lp(file), "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        if fallback is not _MISSING:
            return fallback
        raise


def to_json(value, indent: int | None = 2) -> str:
    if indent is None:
        return json.dumps(serial(value), ensure_ascii=False, separators=(",", ":"))
    return json.dumps(serial(value), ensure_ascii=False, indent=indent)


def write_json(file, value) -> None:
    write_text(file, to_json(value) + "\n")


def read_text(file) -> str:
    # newline="" keeps \r\n as it is on disk: line counts and the byte-exact
    # template check depend on it.
    with open(lp(file), "r", encoding="utf-8", errors="replace", newline="") as fh:
        return fh.read()


def write_text(file, text: str) -> None:
    Path(lp(file)).parent.mkdir(parents=True, exist_ok=True)
    with open(lp(file), "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


def resolve_workspace(system: str, explicit=None) -> Path | None:
    """Find the workspace that holds `artifacts/<system>`.

    The skill normally lives at `<workspace>/skills/sap-abap-tdd`, so the workspace
    is two levels up; `--workspace` overrides that for development runs elsewhere.
    """
    candidates = [Path(explicit).resolve()] if explicit else []
    d = SKILL_DIR
    for _ in range(6):
        candidates.append(d)
        d = d.parent
    for c in candidates:
        if (c / "artifacts" / system / ".adt").exists():
            return c
    return None


class RunPaths:
    """All paths of one analysis run, derived from system + package + run id."""

    def __init__(self, workspace, system: str, pkg: str, run_id: str):
        self.connDir = Path(workspace) / "artifacts" / system
        self.pkgRoot = self.connDir / ".scratchpad" / "tdd" / safe_folder(pkg)
        self.runDir = self.pkgRoot / run_id
        self.state = self.runDir / "run.json"
        self.discover = self.runDir / "discover"
        self.src = self.runDir / "src"
        self.bundle = self.runDir / "bundle"
        self.meta = self.runDir / "meta"
        self.facts = self.runDir / "facts.json"
        self.slots = self.runDir / "slots.json"
        self.notes = self.runDir / "notes"
        self.sections = self.runDir / "sections"
        self.output = self.connDir / ".artifacts" / f"{safe_folder(pkg)}_Technical_Document.html"


def new_run_id() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


def text_of(html: str) -> str:
    """Strip tags and collapse whitespace — for text length checks, not for display."""
    s = re.sub(r"<style[\s\S]*?</style>", "", str(html), flags=re.I)
    s = re.sub(r"<script[\s\S]*?</script>", "", s, flags=re.I)
    s = re.sub(r"<[^>]*>", " ", s)
    s = re.sub(r"&nbsp;|&#xa0;", " ", s)
    s = s.replace("&amp;", "&")
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def escape_html(s) -> str:
    s = "" if nullish(s) else str(s)
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def utf8_stdout() -> None:
    """The driver prints · — → ; a Windows console codepage would crash on them."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass


def js_number(n) -> str:
    """Numbers as JavaScript prints them (no trailing .0)."""
    if isinstance(n, float) and n.is_integer():
        return str(int(n))
    return str(n)


def env_path_exists(p) -> bool:
    return os.path.exists(p)
