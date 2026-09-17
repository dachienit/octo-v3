"""The one optional writing task for the model: chapter 1 in prose.

Everything in the document is generated from the snapshot by compose.py — tables,
lists, counts and the data flow diagram — and the Functional Description keeps the
template's own guidance, for the functional team to fill in. What a script cannot
write is a narrative of why the package exists. When the user asks for it
(`next.py --with-prose`), the driver hands out one task: chapter 1 in prose, written
from facts only.

The packet holds every fact the task needs, so the model reads one small file and
no source code. Live runs showed why that matters: gpt-5-nano did not read the
source files it was given, and a 62 KB class was cut at the read tool's 50 KB limit.
"""

from __future__ import annotations

from flow import build_flow
from lib import fwd, write_text

# Chapter keys the model writes prose for, mapped to template slot ids.
PROSE_SLOTS = {
    "motivation": "TechnicalDocument-MotivationandKeyFigures",
    "short": "TechnicalDocument-Shortdescriptionandsummaryoffunctions",
    "benefits": "TechnicalDocument-Businessproblemssolved,benefits",
}


def section_file(P, key):
    return P.sections / f"{key}.html"


COMMON_RULES = [
    "Write in English, in plain technical prose, for an SAP developer who has to maintain this code.",
    "Output HTML fragments only: `<h3>`, `<h4>`, `<p>`, `<ul>`, `<ol>`, `<li>`, `<table>`, `<tr>`, `<th>`, `<td>`, `<code>`, `<em>`, `<strong>`. Never `<h1>`, `<h2>`, `<html>`, `<body>`, `<script>`, `<style>`.",
    "Name SAP objects exactly as written in the facts (e.g. `/RB4R/MM_CL_QARR_LIST`). Never invent an object, table, function module, transaction or field name. A validator rejects the file if it contains a name that is not in the snapshot.",
    "Describe only what the facts show. Where you infer intent, say so (\"The code suggests …\"). Never state business facts (users, volumes, owners, dates, tickets) that are not in the packet.",
    "Each file is placed ABOVE a generated summary in its chapter, which already lists the entry points, classes and effects. Do not repeat those lists; explain what they add up to.",
]


def _bullet(items):
    return "\n".join(f"- {x}" for x in items) if items else "- (none)"


def _flow_lines(facts) -> list[str]:
    lines = []
    for ch in build_flow(facts):
        if ch["kind"] == "report":
            via = f"transaction {', '.join(f'`{t}`' for t in ch['tcodes'])} → " if ch["tcodes"] else ""
            head = f"{via}report `{ch['name']}`"
        else:
            head = f"function module `{ch['name']}`"
        lines.append(head + (f" — {ch['description']}" if ch["description"] else ""))
        for n, s in enumerate(ch["steps"], 1):
            e = s["effects"]
            parts = [
                f"reads {', '.join(e['reads'][:6])}" if e["reads"] else "",
                f"writes {', '.join(e['writes'])}" if e["writes"] else "",
                f"changes data via {', '.join(e['changes'])}" if e["changes"] else "",
                "ALV list" if e["alv"] else "",
                "e-mail" if e["mail"] else "",
                f"authorization {', '.join(e['auth'])}" if e["auth"] else "",
            ]
            lines.append(f"  {n}. `{s['class']}` → {s['method']}: " + ("; ".join(p for p in parts if p) or "no data access"))
    return lines


def _intro_packet(P, facts) -> str:
    def t(k):
        return fwd(section_file(P, k))

    tot = facts["totals"]
    root = facts["packages"][0] if facts["packages"] else {}
    return "\n".join([
        "# Writing task — chapter 1 of the technical document",
        "",
        "## Rules",
        _bullet(COMMON_RULES),
        "",
        "## Facts (extracted by script from the SAP snapshot — trustworthy)",
        f"- Root package `{facts['root']}`" + (f" — {root['description']}" if root.get("description") else "")
        + f"; system {facts['system']}; {tot['packages']} package(s), {tot['objects']} objects, {tot['codeLines']} lines of code.",
        "- Entry points and what their processing steps do, in call order:",
        _bullet(_flow_lines(facts)),
        "- Classes:",
        _bullet([f"`{c['name']}` — {c['description']}" for c in facts["classes"].values()]),
        "",
        "## Files to write",
        f"1. {t('motivation')} — 1–2 paragraphs: why this package exists and its main purpose, as the facts show it.",
        f"2. {t('short')} — one paragraph that summarises the main functions.",
        f"3. {t('benefits')} — start with exactly `<p><em>Inferred from the code; to be confirmed by the package owner.</em></p>`, then one paragraph on the problems these functions solve.",
    ])


def plan_tasks(P, facts, state) -> list[dict]:
    """Tasks in execution order. Writes the packet files as a side effect."""
    packets_dir = P.runDir / "packets"
    for d in (packets_dir, P.sections):
        d.mkdir(parents=True, exist_ok=True)
    intro = packets_dir / "intro.md"
    write_text(intro, _intro_packet(P, facts))
    return [{"id": "intro", "title": "write the introduction (chapter 1)", "packet": intro,
             "targets": [section_file(P, k) for k in PROSE_SLOTS]}]
