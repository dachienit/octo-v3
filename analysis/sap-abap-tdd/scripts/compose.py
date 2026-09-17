"""Assemble the document: generated blocks (+ optional prose), poured into the
template's slots, validated, written.

Every chapter is built here from facts.json — every table, list, count and diagram,
including the Data Flow Diagram. The Functional Description gets no fragment: the
template's own guidance stays there for the functional team. Prose from the optional
intro task (sections/*.html, `--with-prose`) is checked before it is used: no H1/H2
or scripts, and no SAP object names that do not exist in the snapshot. A fragment
that fails is left out and reported back to the driver, which sets it aside and
hands its task out again; the document is written either way.
"""

from __future__ import annotations

import re

from lib import (
    UNDEF, coalesce, escape_html as esc, fwd, js_str, locale_key, read_text,
    text_of, write_json, write_text,
)
from flow import build_flow, is_empty, total_effects
from packets import PROSE_SLOTS, section_file
from template import fill, load_template, parse_slots, verify_skeleton

NOT_DERIVABLE = "<p><em>Not derivable from static code analysis — to be completed by the package owner.</em></p>"
MAX_DIAGRAM_NODES = 40
A = re.A


def code(s) -> str:
    return f"<code>{esc(s)}</code>"


def table(headers, rows) -> str:
    if not rows:
        return ""
    return "\n".join([
        "<table>",
        "<tr>" + "".join(f"<th>{esc(h)}</th>" for h in headers) + "</tr>",
        *("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows),
        "</table>",
    ])


def mermaid(src: str) -> str:
    return f'<pre class="mermaid">\n{esc(src)}\n</pre>'


def nid(prefix, name) -> str:
    """Mermaid node id: letters/digits only, stable per name."""
    return f"{prefix}_{re.sub(r'[^A-Za-z0-9]', '_', str(name))}"


def lbl(s) -> str:
    """Mermaid label: quotes are the only thing that must not appear inside "…"."""
    return str(s).replace('"', "'")


def uniq(items) -> list:
    return list(dict.fromkeys(items))


def _join_nonempty(parts) -> str:
    return "\n".join(p for p in parts if p)


def _obj(facts, name) -> dict:
    return facts["objects"].get(name) or {}


# ---------------------------------------------------------------------------
# Generated blocks per chapter
# ---------------------------------------------------------------------------

WRITE_ACCESS = {"UPDATE": "Update", "INSERT": "Create", "MODIFY": "Create/Update", "DELETE": "Delete"}


def _block_packages(facts):
    pk = facts["packages"]
    tree = ["graph TD"]
    for p in pk:
        count = f"<br/>{p['objectCount']} objects" if p["objectCount"] else ""
        tree.append(f'  {nid("P", p["name"])}["{lbl(p["name"])}{count}"]')
        if p["parent"]:
            tree.append(f"  {nid('P', p['parent'])} --> {nid('P', p['name'])}")
    deps = ["flowchart LR"]
    for e in facts["packageEdges"]:
        deps.append(f'  {nid("P", e["from"])}["{lbl(e["from"])}"] -- "{e["count"]}" --> {nid("P", e["to"])}["{lbl(e["to"])}"]')

    tables = sorted(facts["tables"].values(), key=lambda t: (-int(bool(t["custom"])), locale_key(t["name"])))
    table_rows = []
    for t in tables:
        writes = ", ".join(uniq("Read" if w["op"] == "SELECT" else WRITE_ACCESS.get(w["op"], w["op"]) for w in t["write"])) if t["write"] else ""
        access = ", ".join(x for x in ["Read" if t["read"] else "", writes] if x)
        fields = "&lt;All Fields&gt;" if "*" in t["fields"] else " ".join(esc(f) for f in t["fields"][:12])
        used_in = "<br/>".join(code(x) for x in uniq(e["obj"] for e in t["read"] + t["write"])[:8])
        name_cell = code(t["name"]) + (f"<br/><small>{esc(t['description'])}</small>" if t["description"] else "")
        table_rows.append([name_cell, fields or "", access, used_in])

    def short_counts(by_type):
        out = {}
        for k, v in by_type.items():
            head = k.split("/")[0]
            out[head] = out.get(head, 0) + v
        return ", ".join(f"{k} {v}" for k, v in sorted(out.items(), key=lambda kv: -kv[1]))

    pkg_rows = [[code(p["name"]), esc(coalesce(p["description"], "")), code(p["parent"]) if p["parent"] else "(root)", esc(short_counts(p["byType"]))] for p in pk]

    external = list(facts["externalCustom"].items())
    edges = facts["packageEdges"]
    return _join_nonempty([
        "<h3>Package hierarchy</h3>",
        mermaid("\n".join(tree)),
        table(["Package", "Description", "Parent", "Objects"], pkg_rows),
        "<h3>Dependencies between the packages</h3>" if edges else "",
        "<p>Number of references from objects of one package to objects of another.</p>" if edges else "",
        mermaid("\n".join(deps)) if edges else "",
        "<h3>Custom objects used from outside the package</h3>" if external else "",
        table(["Object", "Used by package"], [[code(n), ", ".join(code(b) for b in by)] for n, by in external[:60]]) if external else "",
        "<h3>Used SAP tables</h3>",
        "<p>Database tables accessed by the code. Access: Create, Read, Update, Delete. Found by static scan of SELECT / INSERT / UPDATE / MODIFY / DELETE statements.</p>",
        table(["Table Name", "Accessed Fields", "Access", "Used in"], table_rows) or "<p>No database access statements found.</p>",
        _block_inventory(facts),
    ])


# Object types in the order a reader looks for them: entry points, code, dictionary, rest.
TYPE_ORDER = ("TRAN", "PROG", "CLAS", "INTF", "FUGR", "DDLS", "DCLS", "VIEW", "TABL", "TTYP", "DTEL", "DOMA", "MSAG", "TOBJ", "SUSH", "PINF", "DEVC")


def _type_rank(type_id) -> int:
    head = str(type_id).split("/")[0]
    return TYPE_ORDER.index(head) if head in TYPE_ORDER else len(TYPE_ORDER)


def _block_inventory(facts):
    """Every repository object of the tree — including the dictionary objects that are
    not pulled (data elements, table types): the inventory still names them."""
    inv = sorted(facts["objects"].values(), key=lambda o: (_type_rank(o["typeId"]), str(o["typeId"]), locale_key(o["name"])))
    rows = [[code(o["name"]), esc(o["typeId"]), esc(o["description"]), code(o["package"]),
             esc(str(o.get("changedAt") or "")[:10]), esc(o.get("changedBy") or "")] for o in inv]
    return _join_nonempty([
        "<h3>Object inventory</h3>",
        f"<p>All {len(inv)} repository objects of the analysed package tree.</p>",
        table(["Object", "Type", "Description", "Package", "Changed on", "Changed by"], rows),
    ])


def _params_text(f):
    parts = [("Importing", f["params"]["importing"]), ("Exporting", f["params"]["exporting"]),
             ("Changing", f["params"]["changing"]), ("Tables", f["params"]["tables"])]
    return "; ".join(f"{k}: {', '.join(v)}" for k, v in parts if v)


def _block_apis(facts):
    gen = re.compile(r"Extended Table Maintenance|Generated", re.I)
    provided = [f for f in facts["functionModules"] if not gen.search(coalesce(_obj(facts, f["group"]).get("description", UNDEF), ""))]
    prov_rows = [[code(f["name"]), code(f["group"]), esc(_params_text(f))] for f in provided]
    intf_rows = [[code(i["name"]), esc(i["description"]), esc(", ".join(m["name"] for m in i["methods"]))] for i in facts["interfaces"].values()]
    consumed = sorted((c for c in facts["calls"].values() if not c["inSnapshot"]), key=lambda c: -len(c["callers"]))
    cons_rows = [[
        code(c["name"]),
        esc(", ".join(x for x in ["in update task" if c["updateTask"] else "", "RFC" if c["rfc"] else "", "new task" if c["newTask"] else ""] if x)),
        "<br/>".join(code(x) for x in uniq(e["obj"] for e in c["callers"])[:6]),
    ] for c in consumed]
    tx = [[code(t), ", ".join(code(x) for x in uniq(e["obj"] for e in facts["transactionsCalled"] if e["tcode"] == t))]
          for t in uniq(e["tcode"] for e in facts["transactionsCalled"])]
    sub = [[code(p), ", ".join(code(x) for x in uniq(e["obj"] for e in facts["submits"] if e["program"] == p))]
           for p in uniq(e["program"] for e in facts["submits"])]
    return _join_nonempty([
        "<h3>Provided interfaces</h3>",
        table(["Function module", "Function group", "Parameters"], prov_rows) or "<p>No function modules are provided by the package.</p>",
        table(["Interface", "Description", "Methods"], intf_rows) if intf_rows else "",
        "<h3>Consumed SAP functions</h3>",
        table(["Function module", "Call mode", "Called from"], cons_rows) or "<p>No function module calls found.</p>",
        "<h3>Transactions called</h3>" + table(["Transaction", "Called from"], tx) if tx else "",
        "<h3>Programs submitted</h3>" + table(["Program", "Submitted from"], sub) if sub else "",
    ])


def _block_classes(facts):
    all_classes = list(facts["classes"].values())
    if not all_classes:
        return "<p>The package contains no global classes.</p>"

    def rank(c):
        return len(c["collaborators"]) * 3 + sum(1 for m in c["methods"] if m["visibility"] == "public") + c["loc"] / 200

    top = sorted(all_classes, key=lambda c: -rank(c))[:25]
    names = set([c["name"] for c in top] + list(facts["interfaces"].keys()))
    diagram = ["classDiagram"]
    for c in top:
        diagram.append(f'  class {nid("C", c["name"])}["{lbl(c["name"])}"]')
        # Members as separate lines: `~` (interface methods) is Mermaid's generics marker.
        for m in [m for m in c["methods"] if m["visibility"] == "public"][:15]:
            diagram.append(f"  {nid('C', c['name'])} : +{m['name'].replace('~', '_')}()")
    for i in facts["interfaces"].values():
        diagram.append(f'  class {nid("C", i["name"])}["{lbl(i["name"])}"]\n  <<interface>> {nid("C", i["name"])}')
    for c in top:
        if c["superClass"] and c["superClass"] in names:
            diagram.append(f"  {nid('C', c['superClass'])} <|-- {nid('C', c['name'])}")
        for i in c["interfaces"]:
            if i in names:
                diagram.append(f"  {nid('C', i)} <|.. {nid('C', c['name'])}")
        for x in c["collaborators"]:
            if x in names and x != c["name"]:
                diagram.append(f"  {nid('C', c['name'])} --> {nid('C', x)}")

    def size(c):
        m = c.get("metrics")
        if m:
            return f"{js_str(m.get('methodCount', UNDEF))} methods, max complexity {js_str(m.get('maxComplexity', UNDEF))}"
        return f"{c['loc']} lines"

    rows = [[
        code(c["name"]) + f"<br/><small>{esc(c['package'])}</small>",
        esc(coalesce(c["description"], "")),
        esc(", ".join(m["name"] for m in c["methods"] if m["visibility"] == "public")),
        esc(", ".join(m["name"] for m in c["methods"] if m["visibility"] != "public")),
        "<br/>".join(code(x) for x in [x for x in c["collaborators"] if x in facts["objects"]][:8]),
        size(c),
    ] for c in top]
    return "\n".join([mermaid("\n".join(diagram)),
                      table(["Class", "Description", "Public methods", "Protected / private methods", "Collaborators", "Size"], rows)])


def _block_data_model(facts):
    own = [o for o in facts["objects"].values() if re.match(r"(TABL/DT|VIEW/DV|DDLS|TABL/DS|TTYP)", str(o["typeId"]))]

    def kind(t):
        if t == "TABL/DT":
            return "Table"
        if t == "TABL/DS":
            return "Structure"
        if t.startswith("TTYP"):
            return "Table type"
        return "CDS view" if t.startswith("DDLS") else "View"

    def length(f):
        n = f.get("length")
        return "" if n is None else f"{n},{f['decimals']}" if f.get("decimals") else str(n)

    ddic = facts.get("ddicFields") or {}
    field_blocks = []
    for o in own:
        fields = ddic.get(o["name"])
        if not fields:
            continue
        field_blocks.append(f"<h4>{code(o['name'])}" + (f" — {esc(o['description'])}" if o["description"] else "") + "</h4>")
        field_blocks.append(table(["Field", "Key", "Type", "Length", "Description"], [
            [code(f["name"]), "yes" if f.get("isKey") else "", esc(f.get("dataType") or ""), esc(length(f)), esc(f.get("description") or "")]
            for f in fields]))
    elements = facts.get("dataElements") or {}
    dtel_rows = [[code(o["name"]), esc(o["description"]), code(elements[o["name"]]["domain"]) if (elements.get(o["name"]) or {}).get("domain") else "",
                  esc(" ".join(x for x in [(elements.get(o["name"]) or {}).get("dataType") or "", length(elements.get(o["name"]) or {})] if x))]
                 for o in sorted((x for x in facts["objects"].values() if x["typeId"] == "DTEL/DE"), key=lambda x: locale_key(x["name"]))]

    rows = []
    for o in own:
        t = facts["tables"].get(o["name"])
        rows.append([code(o["name"]), esc(kind(o["typeId"])), esc(o["description"]), code(o["package"]),
                     esc(f"read {len(t['read'])}×, written {len(t['write'])}×") if t else ""])
    flow = ["flowchart LR"]
    tables = sorted(facts["tables"].values(), key=lambda t: -(len(t["read"]) + len(t["write"])))[:MAX_DIAGRAM_NODES]
    for t in tables:
        pkgs = uniq(p for p in (_obj(facts, e["obj"]).get("package") for e in t["read"] + t["write"]) if p)
        for p in pkgs:
            writes = any(_obj(facts, e["obj"]).get("package") == p for e in t["write"])
            arrow = "==>|writes|" if writes else "-.->|reads|"
            flow.append(f'  {nid("P", p)}["{lbl(p)}"] {arrow} {nid("T", t["name"])}[("{lbl(t["name"])}")]')
    return _join_nonempty([
        table(["Object", "Kind", "Description", "Package", "Access in code"], rows) if rows else "<p>The package defines no own database tables or views.</p>",
        "<h3>Fields</h3>" if field_blocks else "",
        *field_blocks,
        "<h3>Data elements</h3>" + table(["Data element", "Description", "Domain", "Type"], dtel_rows) if dtel_rows else "",
        "<h3>Data access</h3>" + mermaid("\n".join(flow)) if tables else "",
    ])


def _block_enhancements(facts):
    rows = [[esc(b["kind"]), code(b["badi"]) if b.get("badi") else "(dynamic)", code(b["obj"]), esc(f"{b['file']}:{b['line']}")] for b in facts["badis"]]
    objs = [[esc(e["typeId"]), code(e["name"]), esc(e["description"]), code(e["package"])] for e in facts["enhancementObjects"]]
    if not rows and not objs:
        return "<p>No BAdI calls, enhancement points, enhancement implementations or customer exits were found in the package (static scan).</p>"
    return _join_nonempty([
        table(["Kind", "BAdI / exit", "Used in", "Location"], rows) if rows else "",
        "<h3>Enhancement objects in the package</h3>" + table(["Type", "Name", "Description", "Package"], objs) if objs else "",
    ])


def _block_auth(facts):
    by_obj = {}
    for a in facts["authChecks"]:
        rec = by_obj.setdefault(a["object"], {"fields": {}, "where": {}})
        for f in a["fields"]:
            rec["fields"][f] = None
        rec["where"][a["obj"]] = None
    rows = [[code(o), esc(", ".join(v["fields"])), "<br/>".join(code(x) for x in list(v["where"])[:8])] for o, v in by_obj.items()]
    sush = [[code(o["name"].strip()), esc(o["description"])] for o in facts["objects"].values() if o["typeId"] == "SUSH"]
    tc = [[code(t["name"]), esc(t["description"]), code(t["program"]) if t["program"] else ""] for t in facts["tcodes"]]
    return _join_nonempty([
        "<h3>Authorization checks in the code</h3>",
        table(["Authorization object", "Fields", "Checked in"], rows) or "<p>No AUTHORITY-CHECK statements found.</p>",
        "<h3>Transaction codes</h3>" + table(["Transaction", "Description", "Program"], tc) if tc else "",
        "<h3>Authorization default values (SU24)</h3>" + table(["Object", "Description"], sush) if sush else "",
        "<p><em>Business roles and their assignment are not derivable from static code analysis — to be completed by the package owner.</em></p>",
    ])


def _block_output(facts):
    kinds = {}
    for o in facts["outputs"]:
        kinds.setdefault(o["kind"], {})[f"{o['obj']}|{coalesce(o.get('via', UNDEF), '')}"] = None
    outputs = table(["Output", "Technology", "Used in"], [[
        esc(k),
        esc(", ".join(uniq(x.split("|")[1] for x in s))),
        "<br/>".join(code(y) for y in uniq(x.split("|")[0] for x in s)[:8]),
    ] for k, s in kinds.items()])

    msg_rows = []
    for m in facts["messages"].values():
        used = {}
        for u in m["used"]:
            r = used.setdefault(u["no"], {"types": [], "where": []})
            if u["type"] not in r["types"]:
                r["types"].append(u["type"])
            if u["obj"] not in r["where"]:
                r["where"].append(u["obj"])
        for no in sorted(used):
            msg_rows.append([code(m["name"]), esc(no), esc(", ".join(used[no]["types"])), esc((m["texts"] or {}).get(no, "")),
                             "<br/>".join(code(x) for x in used[no]["where"][:6])])
    silent = [m for m in facts["messages"].values() if m.get("package") and not m["used"]]
    return _join_nonempty([
        outputs or "<p>No print forms, Adobe / Smart Forms or file output found in the code (static scan).</p>",
        "<h3>Messages</h3>" + table(["Message class", "Number", "Type", "Text", "Used in"], msg_rows) if msg_rows else "",
        (f"<p>Message class(es) {', '.join(code(m['name']) for m in silent)} of the package: none of their messages is "
         "raised by a static MESSAGE statement in the code.</p>") if silent else "",
    ])


def _block_oss(facts):
    hints = [p for p in facts["packages"] if re.search(r"XLSX|EXCEL|ABAP2|LOGGER|JSON", p["name"], re.I)]
    ext = [n for n in facts["externalCustom"] if re.search(r"ZCL_EXCEL|ABAP2XLSX|ZCL_LOGGER", n, re.I)]
    if not hints and not ext:
        return NOT_DERIVABLE
    return "\n".join([
        "<p><em>Possible open-source components, identified by name only — to be verified by the package owner:</em></p>",
        "<ul>",
        *(f"<li>Package {code(p['name'])}" + (f" ({esc(p['description'])})" if p["description"] else "") + "</li>" for p in hints),
        *(f"<li>{code(n)}</li>" for n in ext),
        "</ul>",
    ])


def _block_debt(facts):
    with_metrics = sorted((c for c in facts["classes"].values() if c.get("metrics")), key=lambda c: -(c["metrics"].get("maxComplexity") or 0))[:12]
    big = []
    for o in facts["objects"].values():
        if o["status"] == "pulled" and o["files"]:
            loc = coalesce((facts["classes"].get(o["name"]) or {}).get("loc", UNDEF), (facts["programs"].get(o["name"]) or {}).get("loc", UNDEF), 0)
            big.append({"o": o, "loc": loc})
    big = sorted(big, key=lambda x: -x["loc"])[:10]
    return _join_nonempty([
        "<p>Indicators from static analysis; they are inputs for a rating, not a rating.</p>",
        table(["Class", "Methods", "Highest cyclomatic complexity", "Longest method (statements)", "God class"],
              [[code(c["name"]), js_str(c["metrics"].get("methodCount", UNDEF)), js_str(c["metrics"].get("maxComplexity", UNDEF)),
                js_str(c["metrics"].get("maxMethodLength", UNDEF)), "yes" if c["metrics"].get("isGodClass") else "no"] for c in with_metrics]) if with_metrics else "",
        table(["Largest objects", "Lines"], [[code(x["o"]["name"]), str(x["loc"])] for x in big if x["loc"] > 0]) if big else "",
        "<p><em>Technical debt rating, review date and reviewer are not derivable from static code analysis — to be completed by the package owner.</em></p>",
    ])


def _block_frontend(facts):
    ui5 = [o for o in facts["objects"].values() if re.match(r"(WAPA|WDYA|WDYN|SRVB|SRVD|IWSV|IWSG|SICF|UI5)", str(o["typeId"]))]
    screens = [p for p in facts["programs"].values() if p["screens"]]
    alv = [o for o in facts["outputs"] if o["kind"] == "ALV list"]
    gui = ""
    if screens or alv:
        parts = [
            f"dynpro screens in {', '.join(code(p['name']) for p in screens)}" if screens else "",
            f"ALV lists ({esc(', '.join(js_str(v) for v in uniq(a.get('via', UNDEF) for a in alv)))})" if alv else "",
        ]
        gui = f"<p>SAP GUI user interface: {'; '.join(x for x in parts if x)}.</p>"
    return _join_nonempty([
        table(["Object", "Type", "Description"], [[code(o["name"]), esc(o["typeId"]), esc(o["description"])] for o in ui5]) if ui5 else "<p>No Fiori / UI5 / OData objects in the package.</p>",
        gui,
    ])


def _block_prereq(facts):
    root = facts["packages"][0] if facts["packages"] else None
    sap_fm = sum(1 for c in facts["calls"].values() if not c["custom"])
    sap_tab = sum(1 for t in facts["tables"].values() if not t["custom"])
    ext = list(facts["externalCustom"].keys())
    comp = ""
    if root and root.get("softwareComponent"):
        app = f"; application component: {code(root['applicationComponent'])}" if root.get("applicationComponent") else ""
        comp = f"<p>Software component: {code(root['softwareComponent'])}{app}.</p>"
    return _join_nonempty([
        comp,
        f"<p>The code relies on {sap_fm} SAP standard function module(s) and {sap_tab} SAP standard table(s) (see <em>APIs and other external interfaces</em> and <em>Used SAP tables</em>).</p>",
        (f"<p>It references {len(ext)} custom object(s) outside the analysed package tree, which must exist in the target system: "
         f"{', '.join(code(x) for x in ext[:20])}{' …' if len(ext) > 20 else ''}.</p>") if ext else "",
        "<p><em>Add-ons and business functions are not derivable from static code analysis — to be completed by the package owner.</em></p>",
    ])


def _block_transport(facts):
    by_type = {}
    for o in facts["objects"].values():
        by_type[o["typeId"]] = by_type.get(o["typeId"], 0) + 1
    recent = sorted((o for o in facts["objects"].values() if o.get("changedAt")), key=lambda o: str(o["changedAt"]), reverse=True)[:15]
    tobj = [o for o in facts["objects"].values() if o["typeId"] == "TOBJ/TOB"]
    counts = ", ".join(f"{k} {v}" for k, v in sorted(by_type.items(), key=lambda kv: -kv[1]))
    return _join_nonempty([
        f"<p>The package tree contains {facts['totals']['objects']} repository objects: {esc(counts)}.</p>",
        f"<p>Table maintenance dialogs (maintenance views / view clusters) exist for: {', '.join(code(o['name']) for o in tobj)}; their customizing content is transported separately from the code.</p>" if tobj else "",
        "<h3>Most recently changed objects</h3>" + table(["Object", "Type", "Changed on", "Changed by"],
                                                         [[code(o["name"]), esc(o["typeId"]), esc(str(o["changedAt"])[:10]), esc(coalesce(o.get("changedBy", UNDEF), ""))] for o in recent]) if recent else "",
        "<h3>Import sequence</h3>",
        "<p>Dictionary objects (domains, data elements, tables, structures, table types) are needed before the code that uses "
        "them, and a table's maintenance dialog (TOBJ and its generated function group) after the table. Transporting the "
        "package in one request satisfies this; with several requests, import them oldest first.</p>",
        "<h3>Transport requests of the package</h3>" + table(["Request", "Last change", "Owner", "Description"], [
            [code(t["request"]), esc(t["date"]), esc(", ".join(t["users"])), esc(t["text"])]
            for t in (facts.get("transports") or [])[:25]]) if facts.get("transports") else "",
        "<p><em>Downtime relevance and critical objects are not derivable from static code analysis — to be completed by the package owner.</em></p>",
    ])


def _block_local_adaptation(facts):
    tobj = [o for o in facts["objects"].values() if o["typeId"] == "TOBJ/TOB"]
    read_only_custom = [t for t in facts["tables"].values() if t["custom"] and t["read"] and not t["write"]]
    if not tobj and not read_only_custom:
        return NOT_DERIVABLE
    return "\n".join([
        "<p>Candidates for local customizing, derived from the code (to be confirmed):</p>",
        table(["Object", "Why it is a candidate"], [
            *([code(o["name"]), esc(f"Table maintenance object — {o['description']}")] for o in tobj),
            *([code(t["name"]), esc("Custom table that the code only reads" + (f" — {t['description']}" if t["description"] else ""))] for t in read_only_custom),
        ]),
    ])


def _block_motivation(facts):
    t = facts["totals"]
    root = facts["packages"][0] if facts["packages"] else {}
    purpose = ""
    if root.get("description"):
        owner = f" Responsible: {esc(root['responsible'])}." if root.get("responsible") else ""
        purpose = f"<p>{code(facts['root'])} — {esc(root['description'])}.{owner}</p>"
    return _join_nonempty([
        purpose,
        f"<p>The analysed package tree {code(facts['root'])} on system {esc(facts['system'])} consists of {t['packages']} package(s) "
        f"with {t['objects']} repository objects and about {t['codeLines']:,} lines of ABAP source.</p>",
        "<p><em>Key figures (number of users, usage volume) are not derivable from static code analysis.</em></p>",
    ])


# ---------------------------------------------------------------------------
# Chapter 1 summary and the data flow — both built from the entry-point chains
# ---------------------------------------------------------------------------

def _block_short(facts, chains):
    root = facts["packages"][0] if facts["packages"] else {}
    head = f"<p>{code(facts['root'])}" + (f" — {esc(root['description'])}" if root.get("description") else "") + "."
    items = []
    for ch in chains:
        desc = f": {esc(ch['description'])}" if ch["description"] else ""
        if ch["kind"] == "report":
            via = f"Transaction {', '.join(code(t) for t in ch['tcodes'])} → report " if ch["tcodes"] else "Report "
            items.append(f"<li>{via}{code(ch['name'])}{desc}</li>")
        else:
            items.append(f"<li>Function module {code(ch['name'])}{desc}</li>")
    classes = [f"<li>{code(c['name'])}: {esc(c['description'])}</li>" for c in facts["classes"].values() if c["description"]]
    return _join_nonempty([
        head + (f" Its functions are reached through {len(items)} entry point(s):</p>" if items else "</p>"),
        "<ul>" + "".join(items) + "</ul>" if items else "",
        "<p>Main classes:</p><ul>" + "".join(classes) + "</ul>" if classes else "",
    ])


def _block_benefits(facts, chains):
    agg = total_effects(chains)
    own_tables = [t for t in agg["writes"] if (facts["tables"].get(t) or {}).get("custom")]
    sap_tables = [t for t in agg["writes"] if t not in own_tables]
    items = [
        f"Changes SAP data through {', '.join(code(x) for x in agg['changes'])} instead of manual maintenance." if agg["changes"] else "",
        f"Keeps its results in the package's own table(s) {', '.join(code(x) for x in own_tables)}." if own_tables else "",
        f"Updates SAP table(s) {', '.join(code(x) for x in sap_tables)} directly." if sap_tables else "",
        f"Commits each change explicitly ({', '.join(code(x) for x in agg['commits'])})." if agg["commits"] else "",
        "Informs the responsible users by e-mail." if agg["mail"] else "",
        "Presents the processed data in an ALV list for review." if agg["alv"] else "",
        f"Restricts the processing to authorized users ({', '.join(code(x) for x in agg['auth'])})." if agg["auth"] else "",
    ]
    if not any(items) and agg["reads"]:
        items.append(f"Evaluates SAP data from {', '.join(code(x) for x in agg['reads'][:8])}.")
    items = [x for x in items if x]
    if not items:
        return NOT_DERIVABLE
    return "<p><em>Inferred from the code; to be confirmed by the package owner.</em></p>\n<ul>" + "".join(f"<li>{x}</li>" for x in items) + "</ul>"


def _step_cells(eff):
    def names(items, limit=12):
        more = f"<br/>… {len(items) - limit} more" if len(items) > limit else ""
        return "<br/>".join(code(x) for x in items[:limit]) + more

    output = [x for x in ["ALV list" if eff["alv"] else "", f"E-mail ({', '.join(eff['mail'])})" if eff["mail"] else "", *eff["outputs"]] if x]
    return [names(eff["reads"]), names(eff["writes"] + eff["changes"]), names(eff["calls"] + eff["commits"]),
            esc("; ".join(output)), names(eff["auth"])]


def _block_dataflow(facts, chains):
    chains = [c for c in chains if c["steps"] or not is_empty(c["own"])]
    if not chains:
        return ("<p>No entry point (report, transaction or provided function module) with traceable processing was "
                "found by the static scan.</p>")
    entry, groups, edges = [], {}, []
    reads, changes, outs = {}, {}, {}

    def effects(src, eff):
        for t in eff["reads"]:
            i = nid("T", t)
            reads[i] = f'{i}[("{lbl(t)}")]'
            edges.append(f"{i} -.->|read| {src}")
        for t in eff["writes"]:
            i = nid("W", t)
            changes[i] = f'{i}[("{lbl(t)}")]'
            edges.append(f"{src} ==>|write| {i}")
        for f in eff["changes"]:
            i = nid("B", f)
            changes[i] = f'{i}{{{{"{lbl(f)}"}}}}'
            edges.append(f"{src} ==> {i}")
        if eff["alv"]:
            outs["O_ALV"] = 'O_ALV[["ALV list"]]'
            edges.append(f"{src} --> O_ALV")
        if eff["mail"]:
            outs["O_MAIL"] = 'O_MAIL[["E-mail"]]'
            edges.append(f"{src} --> O_MAIL")
        for o in eff["outputs"]:
            i = nid("O", o)
            outs[i] = f'{i}[["{lbl(o)}"]]'
            edges.append(f"{src} --> {i}")

    sections = []
    headers = ["Step", "Class / method", "Reads", "Changes", "Other calls", "Output", "Authorization"]
    for ci, ch in enumerate(chains, 1):
        if ch["kind"] == "report":
            src = nid("R", ch["name"])
            entry.append(f'{src}["Report {lbl(ch["name"])}"]')
            for t in ch["tcodes"]:
                x = nid("X", t)
                entry.append(f'{x}(["Transaction {lbl(t)}"])')
                edges.append(f"{x} --> {src}")
            title = f"Report {code(ch['name'])}" + (f", started by transaction {', '.join(code(t) for t in ch['tcodes'])}" if ch["tcodes"] else "")
        else:
            src = nid("F", ch["name"])
            entry.append(f'{src}[["Function module {lbl(ch["name"])}"]]')
            title = f"Function module {code(ch['name'])}"
        effects(src, ch["own"])
        rows = [["–", "(the entry point itself)", *_step_cells(ch["own"])]] if not is_empty(ch["own"]) else []
        prev = src
        for n, s in enumerate(ch["steps"], 1):
            m = nid("M", f"{ci}_{s['class']}_{s['method']}")
            auth = f"<br/>auth: {', '.join(s['effects']['auth'])}" if s["effects"]["auth"] else ""
            # "Step n" rather than "n.": Mermaid 11 reads a label starting "1. " as a Markdown list.
            groups.setdefault(s["class"], []).append(f'{m}["Step {n}<br/>{lbl(s["method"])}{lbl(auth)}"]')
            edges.append(f"{prev} --> {m}")
            prev = m
            effects(m, s["effects"])
            rows.append([str(n), code(s["class"]) + "<br/>" + code(s["method"]), *_step_cells(s["effects"])])
        sections.append(f"<h4>{title}</h4>")
        sections.append(table(headers, rows) or "<p>No class methods are called and no data access was found.</p>")

    # Keep the diagram readable: when it grows too big, drop the least-used tables that
    # are only read. The step tables still list every one of them.
    note = ""
    fixed = len(uniq(entry)) + sum(len(v) for v in groups.values()) + len(changes) + len(outs)
    room = max(0, MAX_DIAGRAM_NODES - fixed)
    if len(reads) > room:
        uses = {i: sum(1 for e in edges if e.startswith(i + " ")) for i in reads}
        keep = set(sorted(reads, key=lambda i: -uses[i])[:room])
        dropped = [i for i in reads if i not in keep]
        reads = {i: v for i, v in reads.items() if i in keep}
        edges = [e for e in edges if e.split(" ", 1)[0] not in dropped]
        note = f"<p><em>{len(dropped)} less-used table(s) that are only read are left out of the diagram; the step tables list them.</em></p>"

    g = ["flowchart LR", '  subgraph G_ENTRY["Entry points"]', *(f"    {x}" for x in uniq(entry)), "  end"]
    for cls, nodes in groups.items():
        g += [f'  subgraph {nid("G", cls)}["{lbl(cls)}"]', *(f"    {x}" for x in nodes), "  end"]
    for gid, title, nodes in (("G_READ", "Data read", reads), ("G_CHANGE", "Data changed", changes), ("G_OUT", "Output", outs)):
        if nodes:
            g += [f'  subgraph {gid}["{title}"]', *(f"    {x}" for x in nodes.values()), "  end"]
    g += [f"  {e}" for e in uniq(edges)]
    return _join_nonempty([
        "<h3>Data flow</h3>",
        "<p>From each entry point through the processing steps to the data they read and change and the output they "
        "produce. Dotted arrows are reads, thick arrows are changes; a step includes what the private methods it calls "
        "do. Derived from the code by static analysis.</p>",
        mermaid("\n".join(g)),
        note,
        "<h3>Processing steps</h3>",
        *sections,
    ])


# ---------------------------------------------------------------------------
# Chapter 4 and 5 — roles, deletion, release notes
# ---------------------------------------------------------------------------

def _block_roles(facts):
    by_obj = {}
    for a in facts["authChecks"]:
        r = by_obj.setdefault(a["object"], {"fields": [], "where": []})
        for f in a["fields"]:
            if f not in r["fields"]:
                r["fields"].append(f)
        where = a["obj"] + (f" → {a['unit']}" if a.get("unit") else "")
        if where not in r["where"]:
            r["where"].append(where)
    rows = [[code(o), esc(", ".join(v["fields"])), "<br/>".join(esc(x) for x in v["where"][:8])] for o, v in by_obj.items()]
    rows += [[code("S_TCODE"), esc(f"TCD = {t['name']}"), esc(f"start of transaction {t['name']}")] for t in facts["tcodes"]]
    if not rows:
        return NOT_DERIVABLE
    return _join_nonempty([
        "<p>Authorizations a role needs to run the package, derived from the code. Maintain them in the local roles "
        "(PFCG) of the users who run the transactions, and as SU24 proposals where the package defines them.</p>",
        table(["Authorization object", "Fields", "Checked in"], rows),
    ])


DELETION_ORDER = [
    ("TRAN", "Transactions"), ("PROG/P", "Reports"), ("PROG/I", "Includes"), ("CLAS", "Classes"), ("INTF", "Interfaces"),
    ("FUGR", "Function groups"), ("DDLS", "CDS views"), ("DCLS", "CDS access controls"), ("VIEW", "Views"),
    ("TOBJ", "Table maintenance objects"), ("SUSH", "Authorization defaults (SU24)"), ("TABL/DT", "Database tables"),
    ("TABL/DS", "Structures"), ("TTYP", "Table types"), ("DTEL", "Data elements"), ("DOMA", "Domains"), ("MSAG", "Message classes"),
]


def _block_deletion(facts):
    groups = {label: [] for _, label in DELETION_ORDER}
    other = []
    for o in facts["objects"].values():
        if str(o["typeId"]).startswith(("PINF", "DEVC")):
            continue
        label = next((lab for prefix, lab in DELETION_ORDER if str(o["typeId"]).startswith(prefix)), None)
        (groups[label] if label else other).append(o["name"])
    rows = []
    for _, label in DELETION_ORDER:
        if groups[label]:
            rows.append([str(len(rows) + 1), esc(label), ", ".join(code(x) for x in sorted(groups[label], key=locale_key))])
    if other:
        rows.append([str(len(rows) + 1), "Other objects", ", ".join(code(x) for x in sorted(other, key=locale_key))])
    if not rows:
        return NOT_DERIVABLE
    rows.append([str(len(rows) + 1), "Packages", ", ".join(code(p["name"]) for p in reversed(facts["packages"]))])
    data_tables = [o["name"] for o in facts["objects"].values() if o["typeId"] == "TABL/DT"]
    return _join_nonempty([
        "<p>Deletion order derived from the object types: the users of an object go before the object itself "
        "(transactions before programs, code before the dictionary objects it uses), and the packages last, once empty.</p>",
        table(["Step", "Objects", "Names"], rows),
        (f"<p>Database table(s) {', '.join(code(x) for x in data_tables)} hold data: export or archive what has to be kept "
         "before deleting them.</p>") if data_tables else "",
        "<p>This analysis sees only references from the package to other objects. Check the where-used list of each "
        "object before deleting it.</p>",
    ])


def _block_release_notes(facts):
    trs = facts.get("transports") or []
    if trs:
        rows = [[esc(t["date"]), code(t["request"]), esc(t["text"] + (f" ({', '.join(t['users'])})" if t["users"] else ""))] for t in trs[:40]]
        return _join_nonempty([
            table(["Date", "Transport", "Comment"], rows),
            "<p>Transport requests that carry the package object (R3TR DEVC), newest first (E070 / E071).</p>",
        ])
    changed = {}
    for o in facts["objects"].values():
        day = str(o.get("changedAt") or "")[:10]
        if day:
            rec = changed.setdefault(day, {"objects": [], "by": []})
            if o["name"] not in rec["objects"]:  # a table and its maintenance group share the name
                rec["objects"].append(o["name"])
            if o.get("changedBy") and o["changedBy"] not in rec["by"]:
                rec["by"].append(o["changedBy"])
    if not changed:
        return NOT_DERIVABLE
    rows = [[esc(day), "n/a", "Changed: " + ", ".join(code(x) for x in rec["objects"][:10])
             + (" …" if len(rec["objects"]) > 10 else "") + (esc(f" (by {', '.join(rec['by'])})") if rec["by"] else "")]
            for day, rec in sorted(changed.items(), reverse=True)[:20]]
    why = ("No transport request carrying the package object was found"
           if facts.get("transportsRead") else "The transport history could not be read")
    return _join_nonempty([
        table(["Date", "Transport", "Comment"], rows),
        f"<p><em>{why}; the rows show the objects' last change dates instead.</em></p>",
    ])


# ---------------------------------------------------------------------------
# Validation of model-written fragments
# ---------------------------------------------------------------------------

def _known_names(facts) -> set:
    k = set()

    def add(n):
        if n:
            k.add(str(n).upper().strip())

    for o in facts["objects"].values():
        add(o["name"])
    for key in ("tables", "calls", "messages", "exceptions", "externalCustom"):
        for n in facts[key]:
            add(n)
    for f in facts["functionModules"]:
        add(f["name"])
    for p in facts["packages"]:
        add(p["name"])
    for t in facts["tcodes"]:
        add(t["name"])
        add(t["program"])
    for a in facts["authChecks"]:
        add(a["object"])
    for b in facts["badis"]:
        add(b.get("badi"))
    for c in facts["classes"].values():
        for x in c["collaborators"]:
            add(x)
        for x in c["interfaces"]:
            add(x)
        add(c["superClass"])
    for p in facts["programs"].values():
        for x in p["includes"]:
            add(x)
    return k


def check_fragment(html: str, known: set, require_text: int = 80) -> str | None:
    if re.search(r"<h[12][\s>]", html, re.I):
        return "contains an <h1>/<h2> heading (only <h3>/<h4> are allowed)"
    if re.search(r"<(script|style|html|body|head)\b", html, re.I | A):
        return "contains <script>/<style>/<html>/<body>"
    if len(text_of(html)) < require_text:
        return "is empty or too short"
    text = text_of(html).upper()
    found = [m.group(0) for m in re.finditer(r"/[A-Z0-9]{2,}/[A-Z0-9_]+", text)]
    found += [m.group(0) for m in re.finditer(r"\b[ZY][A-Z0-9]*_[A-Z0-9_]{2,}\b", text, A)]
    names = uniq(re.sub(r"~.*$", "", n) for n in found)
    unknown = [n for n in names if n not in known and not any(k.startswith(n) or n.startswith(k + "~") for k in known)]
    if any(n.startswith("/") for n in unknown) or len(unknown) > 3:
        return f"names objects that are not in the snapshot: {', '.join(unknown[:6])}"
    return None


# ---------------------------------------------------------------------------
# Compose
# ---------------------------------------------------------------------------

def compose(P, facts, state) -> dict:
    template = load_template()
    slots = parse_slots(template)
    known = _known_names(facts)
    rejected = []

    def read_checked(file, require_text=80):
        if not file.exists():
            return None
        html = read_text(file)
        problem = check_fragment(html, known, require_text)
        if problem:
            rejected.append({"file": file, "reason": problem})
            return None
        return re.sub(r"^\s*```(?:html)?\s*|\s*```\s*\Z", "", html)

    prose = {key: read_checked(section_file(P, key)) for key in PROSE_SLOTS}
    chains = build_flow(facts)

    def join(*parts):
        return "\n".join(x for x in parts if x and str(x).strip())

    def S(suffix):
        return f"TechnicalDocument-{suffix}"

    # Functional Description is deliberately absent: an unfilled slot keeps the
    # template's guidance, which is what the functional team fills in.
    fragments = {
        S("MotivationandKeyFigures"): join(prose["motivation"], _block_motivation(facts)),
        S("Shortdescriptionandsummaryoffunctions"): join(prose["short"], _block_short(facts, chains)),
        S("Businessproblemssolved,benefits"): join(prose["benefits"], _block_benefits(facts, chains)),
        S("TechnicalDescription(High-LevelArchitecture)"): _block_dataflow(facts, chains),
        S("Frontendcomponents"): _block_frontend(facts),
        S("Packagestructureanddependencies"): _block_packages(facts),
        S("APIsandotherexternalinterfaces"): _block_apis(facts),
        S("Mostimportantclasses"): _block_classes(facts),
        S("Datamodel"): _block_data_model(facts),
        S("UsedSAPenhancements"): _block_enhancements(facts),
        S("BusinessRoles&Authorizations"): _block_auth(facts),
        S("OutputManagement"): _block_output(facts),
        S("OpenSourceSoftware(OSS)"): _block_oss(facts),
        S("TechnicalDebtTracking"): _block_debt(facts),
        S("TechnicalPrerequisites&Dependencies"): _block_prereq(facts),
        S("TransportConsiderations"): _block_transport(facts),
        S("LocalAdaptation"): _block_local_adaptation(facts),
        S("LocalRolemaintenance"): _block_roles(facts),
        S("DeletionandPhase-out"): _block_deletion(facts),
        S("ReleaseNotes"): _block_release_notes(facts),
    }

    root_desc = facts["packages"][0]["description"] if facts["packages"] else None
    title = f"{facts['root']}{f' - {root_desc}' if root_desc else ''} - Technical Document"
    meta = " &middot; ".join([
        f"Generated by Octo from SAP system <strong>{esc(facts['system'])}</strong>",
        f"snapshot {esc(facts['runId'])}",
        f"{facts['totals']['packages']} packages, {facts['totals']['objects']} objects",
        "static code analysis — review before release",
    ])
    html = fill(template, fragments, title=title, meta=meta, mermaid=True)

    check = verify_skeleton(template, html)
    if not check["ok"]:
        return {"rejected": [], "skeletonError": check["firstDiff"], "filled": 0, "slotCount": len(slots)}

    write_text(P.output, html)
    filled = sum(1 for s in slots if (fragments.get(s["id"]) or "").strip())
    write_json(P.runDir / "report.json", {
        "output": fwd(P.output),
        "slots": [{
            "id": s["id"],
            "level": s["level"],
            "title": s["title"],
            "chars": len(text_of(fragments.get(s["id"]) or "")),
            "notDerivableOnly": (fragments.get(s["id"]) or "").strip() == NOT_DERIVABLE,
        } for s in slots],
        "dataFlow": {"entryPoints": len(chains), "steps": sum(len(c["steps"]) for c in chains)},
        "rejected": [{"file": fwd(r["file"]), "reason": r["reason"]} for r in rejected],
        "mermaidBlocks": html.count('<pre class="mermaid">'),
        "degradations": state["degradations"],
    })
    return {"rejected": rejected, "filled": filled, "slotCount": len(slots)}
