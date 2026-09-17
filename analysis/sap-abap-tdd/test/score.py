#!/usr/bin/env python3
"""Score a generated TDD — against a reference TDD written by people, and/or
against the snapshot it was generated from.

  python score.py --generated <html> [--example <dir with reference *.html>] [--facts <facts.json>]

What it measures, in numbers rather than impressions:
  * heading tree: the generated document must carry the template's 5 H1 + 17 H2;
  * entity recall vs. the reference (--example): custom objects (/RB4R/..., Z..., Y...)
    and the tables of the reference's "Used SAP tables" section;
  * snapshot coverage (--facts): how many of the snapshot's code objects, custom
    tables, called function modules and transaction codes the document names;
  * invented names (--facts): custom names in the document that are not in the snapshot;
  * inventory coverage (--facts): every repository object of the snapshot named in the document;
  * chapters: Functional Description kept as the template has it, the data flow diagram
    and its steps, Release Notes filled, and which chapters still say "Not derivable";
  * prose share: how much of the document the model wrote versus the generated tables.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from lib import parse_args, read_json, read_text, text_of, utf8_stdout  # noqa: E402
from template import load_template, parse_slots  # noqa: E402

utf8_stdout()
args = parse_args(sys.argv[1:])
generated = read_text(args["generated"])

CUSTOM = re.compile(r"/RB[0-9A-Z]*/[A-Z0-9_]{3,}|\b[ZY][A-Z0-9]*_[A-Z0-9_]{2,}\b", re.A)
CODE_TYPES = {"CLAS/OC", "INTF/OI", "PROG/P", "PROG/I", "FUGR/F", "FUGR/FF", "FUGR/I", "DDLS/DF", "DDLS/DL"}


def entities(html: str) -> set:
    return {m.group(0) for m in CUSTOM.finditer(text_of(html).upper())}


def reference_tables(html: str) -> set:
    """First-column cells of every reference table whose header says "Table Name"."""
    out = set()
    for t in re.finditer(r"<table[\s\S]*?</table>", html, re.I):
        rows = [r.group(0) for r in re.finditer(r"<tr[\s\S]*?</tr>", t.group(0), re.I)]
        if not rows or not re.search(r"Table\s*Name", text_of(rows[0]), re.I):
            continue
        for r in rows[1:]:
            cell = re.search(r"<t[dh][^>]*>([\s\S]*?)</t[dh]>", r, re.I)
            words = text_of(cell.group(1) if cell else "").upper().split()
            name = words[0] if words else ""
            if re.fullmatch(r"[A-Z/][A-Z0-9_/]{2,29}", name):
                out.add(name)
    return out


def recall(ref: set, gen: set) -> dict:
    hit = [x for x in sorted(ref) if x in gen]
    return {"total": len(ref), "found": len(hit), "pct": round(100 * len(hit) / len(ref)) if ref else 100,
            "missing": [x for x in sorted(ref) if x not in gen][:40]}


# --- heading tree ---------------------------------------------------------------
want = [f"{s['level']} {s['title']}" for s in parse_slots(load_template())]
have = [f"{m.group(1)} {text_of(m.group(2))}" for m in re.finditer(r'<(h[12])\s+id="TechnicalDocument-[^"]+"[^>]*>([\s\S]*?)</\1>', generated)]
gen_text = text_of(generated).upper()
gen_entities = entities(generated)
gen_words = set(re.split(r"[^A-Z0-9_/]+", gen_text))

report: dict = {"headings": {"ok": want == have, "expected": len(want), "found": len(have)}}

# --- reference recall -------------------------------------------------------------
if isinstance(args.get("example"), str):
    ex_dir = args["example"]
    example = "\n".join(read_text(os.path.join(ex_dir, f)) for f in os.listdir(ex_dir) if f.endswith(".html"))
    report["customObjects"] = recall(entities(example), gen_entities)
    report["usedSapTables"] = recall(reference_tables(example), gen_words)

# --- snapshot coverage + invented names ---------------------------------------------
if isinstance(args.get("facts"), str):
    facts = read_json(args["facts"])
    objs = list(facts["objects"].values())
    code_objs = {o["name"] for o in objs if o["status"] == "pulled" and o["typeId"] in CODE_TYPES}
    custom_tables = {k for k, t in facts["tables"].items() if t["custom"]}
    fms = set(facts["calls"].keys())
    tcodes = {t["name"] for t in facts["tcodes"]}
    report["snapshotCoverage"] = {
        "codeObjects": recall(code_objs, gen_words | gen_entities),
        "customTables": recall(custom_tables, gen_words | gen_entities),
        "calledFunctionModules": recall(fms, gen_words),
        "transactionCodes": recall(tcodes, gen_words | gen_entities),
    }
    known = set()
    for o in objs:
        known.add(o["name"])
    for key in ("tables", "calls", "externalCustom", "messages", "exceptions"):
        known.update(facts[key].keys())
    known.update(p["name"] for p in facts["packages"])
    known.update(f["name"] for f in facts["functionModules"])
    for c in facts["classes"].values():
        known.update(c["collaborators"])
    report["invented"] = sorted(n for n in gen_entities if n not in known and not any(k.startswith(n) for k in known))

# --- chapters ----------------------------------------------------------------------------
def slot_html(sid: str) -> str:
    m = re.search(r"<!-- tdd:slot TechnicalDocument-" + re.escape(sid) + r" -->([\s\S]*?)<!-- /tdd:slot -->", generated)
    return m.group(1) if m else ""


dfd = slot_html("TechnicalDescription(High-LevelArchitecture)")
report["functionalKeptAsTemplate"] = "<!-- tdd:slot TechnicalDocument-FunctionalDescription -->" not in generated
report["dataFlow"] = {"diagram": "flowchart" in dfd, "steps": len(re.findall(r"Step \d+&lt;br/&gt;", dfd))}
report["releaseNotesFilled"] = bool(slot_html("ReleaseNotes").strip())
report["notDerivableSlots"] = [m.group(1) for m in re.finditer(r"<!-- tdd:slot TechnicalDocument-([^ ]+) -->\s*<p><em>Not derivable[^<]*</em></p>\s*<!-- /tdd:slot -->", generated)]
if isinstance(args.get("facts"), str):
    norm_text = re.sub(r"\s+", " ", gen_text)
    names = {re.sub(r"\s+", " ", o["name"].upper()) for o in facts["objects"].values()}
    hit = sorted(n for n in names if n in norm_text)
    report["snapshotCoverage"]["allObjects"] = {"total": len(names), "found": len(hit), "pct": round(100 * len(hit) / len(names)) if names else 100,
                                                "missing": sorted(names - set(hit))[:40]}

# --- prose share -----------------------------------------------------------------------
prose = 0
for m in re.finditer(r"<!-- tdd:slot [^>]*? -->([\s\S]*?)<!-- /tdd:slot -->", generated):
    frag = re.sub(r"<table[\s\S]*?</table>|<pre class=\"mermaid\">[\s\S]*?</pre>", "", m.group(1))
    prose += len(text_of(frag))
report["mermaidBlocks"] = generated.count('<pre class="mermaid">')
report["generatedChars"] = len(gen_text)
report["proseChars"] = prose
print(json.dumps(report, indent=2, ensure_ascii=False))
