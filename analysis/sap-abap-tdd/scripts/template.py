"""The TDD template as a mould: find its slots, fill them, and prove that nothing
outside the slots changed.

A slot is the space under one H1/H2 heading of the template, addressed by the
heading's `id` (e.g. `TechnicalDocument-Datamodel`). Directly under most headings
the template carries a guidance hint — paragraphs or a list set in the accent-blue
italic style ("Why was this package created, ..."). Filling a slot replaces that
hint block with the generated fragment; everything else under the heading (the
form tables for OSS and Technical Debt, the Fiori documentation link) stays
byte-for-byte where it is.

One form table is a placeholder rather than content: Release Notes carries a
Date / Transport / Comment table whose rows are all blank. A form table with no
text in any cell counts as part of the hint, so a filled slot replaces it with the
generated rows instead of leaving an empty table under them. A slot left unfilled
keeps its hint — Functional Description is left that way on purpose.

Three places outside the chapter tree are also slots, because a TDD has to be named
after its package: the <title>, the top <h1>, and the `docu-meta` line that the
Docupedia export stamped with the template page's own version and author.

Every inserted fragment is wrapped in `<!-- tdd:slot ID -->` … `<!-- /tdd:slot -->`
so `verify_skeleton` can strip them and compare the rest with the template.
"""

from __future__ import annotations

import re
import sys

from lib import TEMPLATE_PATH, read_text, text_of, utf8_stdout

HINT_MARK = "ds-icon-accent-blue"
HEADING_RE = re.compile(r'<(h[12])\s+id="(TechnicalDocument-[^"]+)"[^>]*>([\s\S]*?)</\1>')
TITLE_SLOT = "tdd:title"
META_SLOT = "tdd:meta"
MERMAID_SLOT = "tdd:mermaid"

FORM_TABLE_RE = re.compile(r'\s*<div class="table-wrap">\s*<table\b[\s\S]*?</table>\s*</div>')

MERMAID_SCRIPT = (
    '<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>\n'
    '<script>mermaid.initialize({ startOnLoad: true, securityLevel: "loose" });</script>'
)


def load_template(file=None) -> str:
    return read_text(file or TEMPLATE_PATH)


def _decode_id(id_: str) -> str:
    """Decode the entities the template uses in heading ids (`&amp;` in `Roles &amp; Authorizations`)."""
    return id_.replace("&amp;", "&")


def _hint_length(html: str, start: int) -> int:
    """Length of the hint block at `start`: a run of <p>/<ul> elements, each carrying
    the accent-blue hint style. Whitespace between them belongs to the run."""
    pos = start
    end = start
    open_re = re.compile(r"\s*<(p|ul)\b[^>]*>")
    while True:
        m = open_re.match(html, pos)
        if not m:
            break
        close = f"</{m.group(1)}>"
        # Hint <p>s never nest another <p>, and hint <ul>s never nest a <ul>, so the
        # first matching close tag ends the element.
        close_at = html.find(close, m.end())
        if close_at < 0:
            break
        element = html[pos:close_at + len(close)]
        if HINT_MARK not in element:
            break
        pos += len(element)
        end = pos
    m = FORM_TABLE_RE.match(html, pos)
    if m and _is_blank_form_table(m.group(0)):
        end = m.end()
    return end - start


def _is_blank_form_table(element: str) -> bool:
    """A form table whose data cells are all empty: a placeholder to be filled in."""
    cells = re.findall(r"<td\b[^>]*>([\s\S]*?)</td>", element)
    return bool(cells) and all(re.sub(r"<br\s*/?>|&nbsp;|\s", "", c) == "" for c in cells)


def parse_slots(html: str) -> list[dict]:
    """The 22 chapter slots in document order."""
    slots = []
    for m in HEADING_RE.finditer(html):
        heading_end = m.end()
        length = _hint_length(html, heading_end)
        slots.append({
            "id": _decode_id(m.group(2)),
            "rawId": m.group(2),
            "level": m.group(1).lower(),
            "title": text_of(m.group(3)),
            "headingEnd": heading_end,
            "hintLength": length,
            "hint": text_of(html[heading_end:heading_end + length]),
        })
    return slots


def _wrap(id_: str, fragment: str) -> str:
    return f"<!-- tdd:slot {id_} -->\n{fragment.strip()}\n<!-- /tdd:slot -->"


def fill(html: str, fragments: dict | None = None, title: str | None = None, meta: str | None = None, mermaid: bool = False) -> str:
    """Fill the template: chapter fragments, document title, meta line, mermaid loader."""
    frag = fragments or {}
    out = []
    cursor = 0
    for slot in parse_slots(html):
        content = frag.get(slot["id"])
        if content is None or content.strip() == "":
            continue
        out.append(html[cursor:slot["headingEnd"]])
        out.append(_wrap(slot["id"], content))
        cursor = slot["headingEnd"] + slot["hintLength"]
    out.append(html[cursor:])
    result = "".join(out)

    if title:
        safe = title.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        # <title> is raw text: a comment inside it would show up in the browser tab, so
        # it carries no marker. verify_skeleton normalises it instead.
        result = re.sub(r"<title>[\s\S]*?</title>", lambda _m: f"<title>{safe}</title>", result, count=1)
        result = re.sub(
            r"<body>\s*<h1>[\s\S]*?</h1>",
            lambda m: re.sub(r"<h1>[\s\S]*?</h1>", lambda _n: f"<h1><!-- tdd:slot {TITLE_SLOT} -->{safe}<!-- /tdd:slot --></h1>", m.group(0), count=1),
            result, count=1,
        )
    if meta:
        result = re.sub(
            r'(<p class="docu-meta">)[\s\S]*?(</p>)',
            lambda m: f"{m.group(1)}<!-- tdd:slot {META_SLOT} -->{meta}<!-- /tdd:slot -->{m.group(2)}",
            result, count=1,
        )
    if mermaid:
        result = result.replace("</body>", f"<!-- tdd:slot {MERMAID_SLOT} -->\n{MERMAID_SCRIPT}\n<!-- /tdd:slot -->\n</body>", 1)
    return result


def _strip_slots(html: str) -> str:
    """Remove every slot marker together with its content."""
    return re.sub(r"<!-- tdd:slot [^>]*? -->[\s\S]*?<!-- /tdd:slot -->\n?", "", html)


def verify_skeleton(template_html: str, output_html: str) -> dict:
    """Prove the output is the template plus slot content and nothing else."""
    filled = [m.group(1) for m in re.finditer(r"<!-- tdd:slot ([^ ]+) -->", output_html)]
    chapter_ids = {s["id"] for s in parse_slots(template_html)}
    fragments = {id_: "X" for id_ in filled if id_ in chapter_ids}

    # Re-derive what the template looks like with the same slots emptied, then empty
    # the output's slots the same way. Anything left that differs was changed outside
    # a slot.
    expected = _strip_slots(fill(
        template_html,
        fragments,
        title="X" if TITLE_SLOT in filled else None,
        meta="X" if META_SLOT in filled else None,
        mermaid=MERMAID_SLOT in filled,
    ))
    actual = _strip_slots(output_html)

    def norm(s):
        return re.sub(r"<title>[\s\S]*?</title>", "<title></title>", s, count=1)

    if norm(expected) == norm(actual):
        return {"ok": True, "filledSlots": filled}
    i = 0
    while i < len(expected) and i < len(actual) and expected[i] == actual[i]:
        i += 1
    return {"ok": False, "filledSlots": filled, "firstDiff": {"at": i, "expected": expected[i:i + 160], "actual": actual[i:i + 160]}}


if __name__ == "__main__":
    # `python template.py [file]` prints the slot table of the bundled template.
    utf8_stdout()
    for s in parse_slots(load_template(sys.argv[1] if len(sys.argv) > 1 else None)):
        print(f"{s['level']}  {s['id']:<62} hint={s['hintLength']:>4}  {s['hint'][:70]}")
