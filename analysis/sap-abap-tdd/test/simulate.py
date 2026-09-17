#!/usr/bin/env python3
"""Offline end-to-end run of the driver — plays the agent, never calls SAP.

  python simulate.py --work <empty dir> [--scenario tree|leaf|empty] [--with-prose]
  python simulate.py --work <empty dir> --scenario replay --record <runDir of a live run>

Keep --work short on Windows (e.g. %TEMP%\\tddr): replay copies a real snapshot whose
file paths are already ~240 characters deep.

The simulator runs next.py, performs the printed action by writing what SAP would
have returned (instead of calling the `adt` tool), and loops until DONE or STOP.
The document needs no writing task; with --with-prose the driver hands out one, and
the simulator answers it with an invented object name first, to exercise the
reject-and-retry path.

Synthetic scenarios need no fixture (the old recorded one kept getting deleted with
the workspace scratchpad). Each ends with assertions and exits non-zero on failure:
  tree  (default) ZTDD_ROOT → ZTDD_A, ZTDD_B → ZTDD_B_SUB (the only code), plus a
        listing that names its parent again (cycle) and one that never succeeds.
        This is the case the first live run got wrong: the root has no code.
        ZTDD_B_SUB also holds a namespaced class, /TDD/CL_NS_HELPER, whose file adt-cli
        names `/tdd/cl_ns_helper.clas.abap` — leading slash included — and fails with
        ENOENT until the `tdd/` folder exists. That covers two live bugs: the driver
        learning the namespace and pulling again, and facts resolving a leading-slash
        file name under the snapshot folder (the Python port first resolved it to the
        drive root and saw an empty package).
  leaf  root ZTDD_B_SUB, which has no sub-packages.
  empty root ZTDD_EMPTY: only a package interface, no code → STOP, never DONE.
  replay  replays a live run directory (discover/, src/, bundle/, meta/) — a
        regression check of the scripts on real SAP data, without SAP.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

from lib import RunPaths, parse_args, read_json, read_text, safe_folder, utf8_stdout, write_json, write_text  # noqa: E402
from template import parse_slots  # noqa: E402

utf8_stdout()
NEXT = HERE.parent / "scripts" / "next.py"
args = parse_args(sys.argv[1:])
work = Path(args["work"]).resolve()
scenario = str(args.get("scenario") or "tree")
record = Path(args["record"]).resolve() if isinstance(args.get("record"), str) else None
with_prose = args.get("with-prose") is True

ROOTS = {"tree": "ZTDD_ROOT", "leaf": "ZTDD_B_SUB", "empty": "ZTDD_EMPTY"}
if scenario == "replay":
    if not record:
        sys.exit("--record <runDir> is required for --scenario replay")
    ROOT = read_json(record / "run.json")["package"]
else:
    ROOT = ROOTS.get(scenario)
    if not ROOT:
        sys.exit(f"unknown scenario: {scenario}")

(work / "artifacts" / "D8R" / ".adt").mkdir(parents=True, exist_ok=True)
write_json(work / "artifacts" / "D8R" / ".adt" / "tree.json", {"version": 1, "entries": {}})


def arg_of(argv, flag):
    return argv[argv.index(flag) + 1]


def devc(name):
    return {"typeId": "DEVC/K", "name": name, "techName": name, "uri": None, "description": "", "expandable": True}


def pinf(name, desc):
    return {"typeId": "PINF/KI", "name": name, "techName": name, "uri": None, "description": desc, "expandable": False}


# ---------------------------------------------------------------------------
# The synthetic SAP system
# ---------------------------------------------------------------------------
LISTINGS = {
    "ZTDD_ROOT": [devc("ZTDD_A"), devc("ZTDD_B"), devc("ZTDD_BROKEN"), pinf("ZTDD_ROOT", "Root interface")],
    "ZTDD_B": [devc("ZTDD_B_SUB"), devc("ZTDD_ROOT")],  # names its own parent again: a cycle
    "ZTDD_EMPTY": [pinf("ZTDD_EMPTY", "Interface only")],
}
UNLISTABLE = "ZTDD_BROKEN"

REPORT_SRC = """REPORT ztdd_report MESSAGE-ID ztdd_msg.
INCLUDE ztdd_report_top.
* Closes purchase orders whose items are fully delivered.
PARAMETERS p_ebeln TYPE ebeln.
SELECT-OPTIONS s_bukrs FOR ekko-bukrs.

START-OF-SELECTION.
  AUTHORITY-CHECK OBJECT 'M_BEST_BSA' ID 'ACTVT' FIELD '02' ID 'BSART' DUMMY.
  IF sy-subrc <> 0.
    MESSAGE e001.
  ENDIF.
  DATA(lo_worker) = NEW zcl_tdd_worker( ).
  lo_worker->close_orders( p_ebeln ). " step 1: inline declaration
  INCLUDE ztdd_report_i01.
"""

# The shape of /RB4R/MM_PO_CLOSED: the reference variable is declared in the TOP
# include and used in another include, so its class is only known across the two.
TOP_SRC = """DATA go_worker TYPE REF TO zcl_tdd_worker.
"""
I01_SRC = """  go_worker = NEW #( ).
  go_worker->notify( ).
"""

CLASS_SRC = """CLASS zcl_tdd_worker DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS close_orders IMPORTING iv_ebeln TYPE ebeln.
    METHODS notify.
  PRIVATE SECTION.
    METHODS write_log IMPORTING iv_text TYPE string.
ENDCLASS.

CLASS zcl_tdd_worker IMPLEMENTATION.
  METHOD close_orders.
    DATA lt_items TYPE STANDARD TABLE OF ekpo.
    SELECT ebeln, ebelp, elikz FROM ekpo INTO TABLE @lt_items WHERE ebeln = @iv_ebeln.
    DATA(lv_closed) = /tdd/cl_ns_helper=>is_closed( 'X' ).
    CALL FUNCTION 'ENQUEUE_EMEKKOE' EXPORTING ebeln = iv_ebeln.
    CALL FUNCTION 'BAPI_PO_CHANGE' EXPORTING purchaseorder = iv_ebeln.
    CALL FUNCTION 'BAPI_TRANSACTION_COMMIT'.
    write_log( |closed { iv_ebeln }| ).
  ENDMETHOD.
  METHOD write_log.
    DATA ls_log TYPE ztdd_log.
    ls_log-text = iv_text.
    INSERT ztdd_log FROM ls_log.
  ENDMETHOD.
  METHOD notify.
    SELECT SINGLE addrnumber FROM usr21 INTO @DATA(lv_addr) WHERE bname = @sy-uname.
    CALL FUNCTION 'SO_NEW_DOCUMENT_SEND_API1' EXPORTING document_data = lv_addr.
  ENDMETHOD.
ENDCLASS.
"""

NS_SRC = """CLASS /tdd/cl_ns_helper DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS is_closed IMPORTING iv_elikz TYPE elikz RETURNING VALUE(rv_closed) TYPE abap_bool.
ENDCLASS.

CLASS /tdd/cl_ns_helper IMPLEMENTATION.
  METHOD is_closed.
    rv_closed = xsdbool( iv_elikz = 'X' ).
  ENDMETHOD.
ENDCLASS.
"""


# What SE54 puts into a generated table-maintenance function group under Z names:
# SAP-standard code that facts.py must not count as the package's own.
UNDO_SRC = """FORM zurueckholen.
  CALL FUNCTION 'VIEWCLUSTER_UNDO_DEPENDENT'.
ENDFORM.
"""
TWO_STEP_SRC = """TABLES: e070, e071k.
DATA maint_stat LIKE vimstatus.
"""


def adt_xml(kind, name, extra=""):
    return (f'<?xml version="1.0" encoding="utf-8"?>\n<{kind} adtcore:name="{name}" adtcore:responsible="TESTER" '
            f'adtcore:changedBy="TESTER" adtcore:changedAt="2026-01-15T10:00:00Z" xmlns:adtcore="http://www.sap.com/adt/core">{extra}</{kind}>\n')


CODE_PACKAGE = {
    "ZTDD_B_SUB": [
        ("PROG/P", "ZTDD_REPORT", "Close delivered purchase orders", {"ztdd_report.prog.abap": REPORT_SRC}),
        ("PROG/I", "ZTDD_REPORT_TOP", "Include ZTDD_REPORT_TOP", {"ztdd_report_top.prog.abap": TOP_SRC}),
        ("PROG/I", "ZTDD_REPORT_I01", "Include ZTDD_REPORT_I01", {"ztdd_report_i01.prog.abap": I01_SRC}),
        ("CLAS/OC", "ZCL_TDD_WORKER", "Order closing worker", {"zcl_tdd_worker.clas.abap": CLASS_SRC}),
        # adt-cli's spelling for namespaced objects: a leading slash, folder not created.
        ("CLAS/OC", "/TDD/CL_NS_HELPER", "Delivery completion helper", {"/tdd/cl_ns_helper.clas.abap": NS_SRC}),
        ("FUGR/F", "ZTDD_MAINT", "Extended Table Maintenance (Generated)", {
            "ztdd_maint.fugr.zurueckholen.abap": UNDO_SRC, "ztdd_maint.fugr.zweistufig.abap": TWO_STEP_SRC}),
        ("TRAN/T", "ZTDD", "Close purchase orders", {"ztdd.tran.xml": adt_xml("tran", "ZTDD")}),
        ("TABL/DT", "ZTDD_LOG", "Closing log", {"ztdd_log.tabl.xml": adt_xml("tabl", "ZTDD_LOG")}),
        ("MSAG/N", "ZTDD_MSG", "Closing messages", {"ztdd_msg.msag.xml": adt_xml(
            "msag", "ZTDD_MSG", '<mc:messages mc:msgno="001" mc:msgtext="No authorization for purchasing document type" xmlns:mc="x"/>')}),
    ],
}


def replay_list(argv):
    out = Path(arg_of(argv, "--output"))
    pkg = arg_of(argv, "--package").upper()
    if scenario == "replay":
        src = record / "discover" / f"{safe_folder(pkg)}.json"
        if src.exists():
            shutil.copyfile(src, out)
        return
    if scenario == "tree" and pkg == UNLISTABLE:
        print("     (simulating a failed listing: no file written)")
        return
    nodes = [n for n in LISTINGS.get(pkg, []) if scenario == "tree" or n["typeId"] != "DEVC/K"]
    write_json(out, {"nodes": nodes, "categories": [], "objectTypes": []})


def replay_pull(argv):
    out = Path(arg_of(argv, "--out"))
    pkg = arg_of(argv, "--package").upper()
    types = set(arg_of(argv, "--include-only").split(","))
    if scenario == "replay":
        src = record / "src" / out.name
        if src.exists():
            shutil.copytree(src, out, dirs_exist_ok=True)
        return
    inventory = []
    for node in LISTINGS.get(pkg, []):
        if node["typeId"] == "PINF/KI":
            inventory.append({"typeId": "PINF/KI", "name": node["name"], "description": node["description"], "uri": None,
                              "package": pkg, "status": "unknown-type", "reason": "no fetcher in pull registry"})
    for type_id, name, desc, files in CODE_PACKAGE.get(pkg, []):
        base = {"typeId": type_id, "name": name, "description": desc, "uri": None, "package": pkg}
        if type_id not in types:
            inventory.append({**base, "status": "not-in-config", "reason": "not in --include-only"})
            continue
        # Like adt-cli: a namespaced file is written relative to --out without creating
        # its folder, so it fails until the driver has created the folder.
        missing = [f for f in files if f.startswith("/") and not (out / f.split("/")[1]).is_dir()]
        if missing:
            inventory.append({**base, "status": "fetch-failed", "reason": f"ENOENT: no such file or directory, open '{out}{missing[0]}'"})
            continue
        for fname, content in files.items():
            write_text(out / fname.lstrip("/"), content)
        listed = list(files)
        if any(f.endswith(".zurueckholen.abap") for f in files):
            listed += [f for f in files if f.endswith(".zurueckholen.abap")]  # adt-cli lists it twice
        inventory.append({**base, "status": "pulled", "files": listed})
    write_json(out / ".abap-package.json", {"schemaVersion": 3, "package": pkg, "objectCount": sum(1 for i in inventory if i["status"] == "pulled"),
                                            "inventory": inventory, "subPackages": []})


def replay_context_build(argv):
    out = Path(arg_of(argv, "--out"))
    pkg = arg_of(argv, "--package").upper()
    if scenario == "replay":
        src = record / "bundle" / safe_folder(pkg)
        if src.exists():
            shutil.copytree(src, out / safe_folder(pkg), dirs_exist_ok=True)
        return
    if pkg == "ZTDD_B_SUB":
        d = out / safe_folder(pkg)
        write_json(d / "manifest.json", {"description": "Order closing", "responsible": "TESTER",
                                         "objects": [{"name": "ZCL_TDD_WORKER", "responsible": "TESTER", "changedAt": "2026-02-01T08:00:00Z"}]})
        write_json(d / "metrics.json", {"classes": [{"name": "ZCL_TDD_WORKER", "methodCount": 2, "maxComplexity": 3,
                                                     "maxMethodLength": 6, "isGodClass": False, "methods": []}]})


def data_preview(columns: dict) -> str:
    """ADT data-preview XML as `adt --raw data sql` saves it: one element per column."""
    return ('<dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview">' + "".join(
        f'<dataPreview:columns><dataPreview:metadata dataPreview:name="{name}"/><dataPreview:dataSet>'
        + "".join(f"<dataPreview:data>{v}</dataPreview:data>" for v in values)
        + "</dataPreview:dataSet></dataPreview:columns>"
        for name, values in columns.items()) + "</dataPreview:tableData>")


# The package object (R3TR DEVC) is on the released requests D8RK900123 (twice) and
# D8RK900125, and on their tasks D8RK900124 / D8RK900126. The join answers with the
# released requests only; without it, E071 names every entry and E070 — whose SQL
# already filters released K/W requests — narrows them down.
TRANSPORT_TABLES = {
    # One column qualified, the way the preview may name it.
    "JOIN": {"TRKORR": ["D8RK900123", "D8RK900123", "D8RK900125"],
             "E070~AS4DATE": ["20260110", "20260110", "20260201"], "AS4USER": ["TESTER", "TESTER", "TESTER"]},
    "E071": {"TRKORR": ["D8RK900124", "D8RK900123", "D8RK900126", "D8RK900125"]},
    "E070": {"TRKORR": ["D8RK900123", "D8RK900125"],
             "E070~AS4DATE": ["20260110", "20260201"], "AS4USER": ["TESTER", "TESTER"]},
    "E07T": {"TRKORR": ["D8RK900123", "D8RK900123", "D8RK900125"], "LANGU": ["D", "E", "E"],
             "AS4TEXT": ["Auftragsabschluss", "Order closing: first version", "Order closing: e-mail"]},
}


sql_sent = []
skipped = []


def replay_sql(argv):
    out = Path(arg_of(argv, "--output"))
    sql = arg_of(argv, "sql").upper()
    sql_sent.append(sql)
    if " JOIN " in sql:
        table = "JOIN"
    else:
        table = next((t for t in TRANSPORT_TABLES if f"FROM {t} " in f"{sql} "), "TSTC")
    if table == "JOIN" and scenario == "leaf":
        # The leaf scenario takes the fallback, for a system whose data preview refuses the join.
        write_text(out, "Only one SELECT statement is allowed.")
        return
    if table == "E07T" and scenario == "tree" and not skipped:
        # A weak model reads the action and runs the driver without it (gpt-5-nano, live 2026-09-14).
        skipped.append(sql)
        print("     (agent skipped this call: no file written)")
        return
    if scenario == "replay":
        src = record / "meta" / out.name
        if src.exists():
            shutil.copyfile(src, out)
        else:
            print(f"     (recorded run had no {out.name}: no file written)")
        return
    if table == "TSTC":
        write_text(out, data_preview({"TCODE": ["ZTDD"], "PGMNA": ["ZTDD_REPORT"], "DYPNO": ["1000"]}))
        return
    write_text(out, data_preview(TRANSPORT_TABLES[table]))


# ---------------------------------------------------------------------------
# Stub prose, using names that exist in the snapshot
# ---------------------------------------------------------------------------
poisoned = False


def stub(file: Path, facts_file: Path) -> str:
    global poisoned
    facts = read_json(facts_file)
    code = [o["name"] for o in facts["objects"].values() if o["status"] == "pulled" and o["typeId"] in ("PROG/P", "CLAS/OC", "FUGR/F", "INTF/OI")]
    a = code[0] if code else facts["root"]
    b = code[1] if len(code) > 1 else a
    tab = next(iter(facts["tables"]), "MARA")
    if file.stem == "motivation" and not poisoned:
        poisoned = True
        return "<p>This package extends <code>/RB4R/DOES_NOT_EXIST</code> and is used by 2000 users every day in all plants.</p>"
    return f"<p>Simulated prose for <strong>{file.stem}</strong>: the program <code>{a}</code> works together with <code>{b}</code> on table <code>{tab}</code>.</p>"


# ---------------------------------------------------------------------------
# The agent loop
# ---------------------------------------------------------------------------
final = None
last_out = ""
for i in range(150):
    out = subprocess.run([sys.executable, str(NEXT), "--system", "D8R", "--package", ROOT, "--workspace", str(work)]
                         + (["--with-prose"] if with_prose else []),
                         capture_output=True, text=True, encoding="utf-8")
    if out.returncode != 0:
        print(out.stdout, out.stderr)
        sys.exit(f"driver crashed with exit code {out.returncode}")
    lines = out.stdout.split("\n")
    print(f"#{i + 1:>2} {lines[0]}")
    if lines[0] in ("DONE", "STOP"):
        print(out.stdout)
        final = lines[0]
        last_out = out.stdout
        break
    if "call the `adt` tool" in out.stdout:
        argv = json.loads(next(l for l in lines if l.startswith("{")))["argv"]
        print("     adt " + " ".join(x for x in argv if x in ("object", "list", "pull", "context", "build", "data", "sql")))
        if "list" in argv:
            replay_list(argv)
        elif "pull" in argv:
            replay_pull(argv)
        elif "context" in argv:
            replay_context_build(argv)
        elif "sql" in argv:
            replay_sql(argv)
    elif "call the `sapgit` tool" in out.stdout:
        print("     sapgit clone (ignored)")
    elif "ACTION: a writing task" in out.stdout:
        packet = Path(next(l for l in lines if "Read this file completely" in l).split(": ", 1)[1].strip())
        if not packet.exists():
            sys.exit(f"packet missing: {packet}")
        facts_file = packet.parent.parent / "facts.json"
        for l in (x for x in lines if x.startswith("   - ")):
            f = Path(l[5:].strip())
            write_text(f, stub(f, facts_file))
            print(f"     wrote {f.name}")
    elif "fix rejected sections" in out.stdout:
        print("\n".join(lines[1:-2]))
    else:
        print(out.stdout)
        sys.exit("unrecognised driver output")

# ---------------------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------------------
failures = []


def check(ok, message):
    if not ok:
        failures.append(message)


run_id = (RunPaths(work, "D8R", ROOT, "_").pkgRoot / "latest.txt").read_text(encoding="utf-8").strip()
P = RunPaths(work, "D8R", ROOT, run_id)
state = read_json(P.state)
pkgs = state["packages"]

if scenario in ("tree", "leaf", "replay"):
    check(final == "DONE", f"expected DONE, got {final}")
    if final == "DONE":
        html = read_text(P.output)
        check(len(parse_slots(html)) == 22, "the document must keep the template's 22 headings")
        check("/RB4R/DOES_NOT_EXIST" not in html, "the invented name must not reach the document")
        facts = read_json(P.facts)
        pulled_code = [o for o in facts["objects"].values() if o["status"] == "pulled" and o["typeId"] in ("CLAS/OC", "PROG/P", "PROG/I", "FUGR/F")]
        check(facts["totals"]["codeLines"] > 0 or not pulled_code, "pulled code must be read (codeLines > 0)")
if scenario in ("tree", "leaf"):
    facts = read_json(P.facts)
    check(state["namespaces"] == ["tdd"], f"the driver should learn the tdd namespace from ENOENT, got {state['namespaces']}")
    check(state["attempts"].get("pull:ZTDD_B_SUB") == 2, "ZTDD_B_SUB should be pulled twice (ENOENT, then with the folder)")
    helper = facts["classes"].get("/TDD/CL_NS_HELPER")
    check(bool(helper) and [m["name"] for m in helper["methods"]] == ["IS_CLOSED"], "the namespaced class must be parsed from its leading-slash file")
    check("/TDD/CL_NS_HELPER" in facts["classes"].get("ZCL_TDD_WORKER", {}).get("collaborators", []), "static call to the namespaced class is a collaborator")
    check("VIEWCLUSTER_UNDO_DEPENDENT" not in facts["calls"], "SAP-standard maintenance code must not add consumed functions")
    check(facts["objects"]["ZTDD_MAINT"]["files"] == [], "the generated group's standard members are not package code")
    check(sorted(s["file"].split(".")[-2] for s in facts["skippedFiles"]) == ["zurueckholen", "zweistufig"],
          f"each standard member skipped once (duplicate listing collapsed), got {facts['skippedFiles']}")
if scenario == "tree":
    check(list(pkgs) == ["ZTDD_ROOT", "ZTDD_A", "ZTDD_B", "ZTDD_BROKEN", "ZTDD_B_SUB"], f"unexpected package walk: {list(pkgs)}")
    check(pkgs["ZTDD_B_SUB"]["parent"] == "ZTDD_B" and pkgs["ZTDD_B_SUB"]["depth"] == 2, "ZTDD_B_SUB should be a depth-2 child of ZTDD_B")
    check(pkgs["ZTDD_ROOT"]["parent"] is None, "the root's parent must stay null despite the cyclic listing")
    check(pkgs[UNLISTABLE].get("listed") == "failed", f"{UNLISTABLE} listing should be recorded as failed")
    check(any(UNLISTABLE in d and "could not be listed" in d for d in state["degradations"]), "the failed listing should be a reported limitation")
    check("Limitations to tell the user" in last_out, "DONE must list the limitations")
    check(facts["tables"].get("EKPO", {}).get("fields") == ["EBELN", "EBELP", "ELIKZ"], "EKPO read with its three fields")
    check([w["op"] for w in facts["tables"].get("ZTDD_LOG", {}).get("write", [])] == ["INSERT"], "ZTDD_LOG written by INSERT")
    check("BAPI_PO_CHANGE" in facts["calls"] and len(facts["locks"]) == 1, "BAPI call and lock found")
    check([a["object"] for a in facts["authChecks"]] == ["M_BEST_BSA"], "authorization check found")
    check(facts["tcodes"][0]["program"] == "ZTDD_REPORT", "TSTC lookup should map ZTDD to ZTDD_REPORT")
    check(facts["messages"]["ZTDD_MSG"]["texts"].get("001", "").startswith("No authorization"), "message text parsed")
    check(facts["classes"]["ZCL_TDD_WORKER"]["metrics"]["methodCount"] == 2, "bundle metrics merged")
    check(facts["programs"]["ZTDD_REPORT"]["parameters"] == 1 and facts["programs"]["ZTDD_REPORT"]["selectOptions"] == 1, "selection screen counted")
    check(next(p for p in facts["packages"] if p["name"] == "ZTDD_B")["subPackages"] == ["ZTDD_B_SUB"], "facts: tree linked")
    check("ZTDD_B_SUB" in read_text(P.output), "the document should name the third-level package")
elif scenario == "leaf":
    check(list(pkgs) == ["ZTDD_B_SUB"], f"expected 1 package, got {list(pkgs)}")
    check(pkgs["ZTDD_B_SUB"].get("listed") == "ok", "the leaf should be listed")
elif scenario == "empty":
    check(final == "STOP", f"expected STOP, got {final}")
    check("No ABAP code was found" in last_out, "STOP must say that no code was found")
    check(not state.get("completedAt"), "the run must not be marked complete")
    check(not P.output.exists(), "no document may be written")

def slot(html, sid):
    m = re.search(r"<!-- tdd:slot TechnicalDocument-" + re.escape(sid) + r" -->([\s\S]*?)<!-- /tdd:slot -->", html)
    return m.group(1) if m else ""


if final == "DONE":
    html = read_text(P.output)
    facts = read_json(P.facts)
    check("tdd:slot TechnicalDocument-FunctionalDescription" not in html and "Describe the individual functions" in html,
          "the Functional Description must stay exactly as the template has it")
    missing = [o["name"] for o in facts["objects"].values() if o["name"] not in html]
    check(not missing, f"every object of the inventory must be in the document, missing: {missing[:5]}")
    tail = html.split('id="TechnicalDocument-ReleaseNotes"', 1)[1]
    check('<td class="confluenceTd"><br/></td>' not in tail, "the template's blank release-note rows must be replaced")
    for sid in ("LocalRolemaintenance", "DeletionandPhase-out", "ReleaseNotes"):
        check(bool(slot(html, sid)) and "Not derivable" not in slot(html, sid), f"{sid} must be filled from the snapshot")
    dfd = slot(html, "TechnicalDescription(High-LevelArchitecture)")
    check("flowchart LR" in dfd, "the data flow diagram must be generated")
    check(with_prose or not state["attempts"].get("task:intro"), "without --with-prose there is no writing task")
if scenario in ("tree", "leaf") and final == "DONE":
    calls = [(c["obj"], c["method"]) for c in facts["methodCalls"] if c["class"] == "ZCL_TDD_WORKER"]
    check(("ZTDD_REPORT", "CLOSE_ORDERS") in calls, f"an inline NEW and its call must resolve, got {calls}")
    check(("ZTDD_REPORT_I01", "NOTIFY") in calls, f"a variable declared in TOP and called in I01 must resolve, got {calls}")
    check(facts["unitCalls"].get("ZCL_TDD_WORKER", {}).get("CLOSE_ORDERS") == ["WRITE_LOG"], "the call of an own private method is recorded")
    for node in ("Step 1&lt;br/&gt;CLOSE_ORDERS", "Step 2&lt;br/&gt;NOTIFY", "W_ZTDD_LOG", "B_BAPI_PO_CHANGE", "O_MAIL", "T_USR21"):
        check(node in dfd, f"the data flow diagram lacks {node}")
    check([t["request"] for t in facts["transports"]] == ["D8RK900125", "D8RK900123"],
          f"transports grouped by request, newest first, got {facts['transports']}")
    check(facts["transports"][1]["text"] == "Order closing: first version",
          f"the English short text wins over the German one, got {facts['transports'][1]['text']!r}")
    check("D8RK900123" in slot(html, "ReleaseNotes"), "the release notes list the transport requests")
    check("D8RK900124" not in slot(html, "ReleaseNotes"), "a task must not show up as a request")
    long_sql = [s for s in sql_sent if len(s) > 240]
    check(not long_sql, f"every SQL statement stays short, got {[len(s) for s in long_sql]}")
    check(any(f"OBJ_NAME = '{ROOT}'" in s and "'DEVC'" in s for s in sql_sent), "E071 is read for the package object only")
    fallback = [s for s in sql_sent if "FROM E070 WHERE" in s]
    if scenario == "leaf":
        check(bool(fallback) and "TRSTATUS = 'R'" in fallback[0], f"the refused join falls back to E071 + E070, got {sql_sent}")
    else:
        check(not fallback, "an accepted join needs no single-table fallback")
    if scenario == "tree":
        check(bool(skipped) and state["attempts"].get("transports:e07t") == 2
              and not any("E07T" in d for d in state["degradations"]),
              f"a lookup the agent skipped is handed out again, attempts {state['attempts']}")
    if with_prose:
        check(state["attempts"].get("task:intro") == 2, "the poisoned introduction must be rejected once and handed out again")
        check("Simulated prose" in slot(html, "MotivationandKeyFigures"), "the accepted introduction must reach chapter 1")
if scenario == "replay" and final == "DONE" and ROOT == "/RB4R/MM_AUTOMAT_CLOSING_PO":
    for name in ("SELECT_DB_DATA", "PROCESS_DATA", "PROCESS_PO_CLOSE", "PROCESS_REQ_DELETE", "PROCESS_EMAIL", "DISPLAY_DATA",
                 "B_BAPI_PO_CHANGE", "B_BAPI_REQUISITION_DELETE", "O_MAIL"):
        check(name in dfd, f"the data flow diagram lacks {name}")
    check("RV_MESSAGES_REFRESH" not in dfd.split("Function module")[0],
          "the function module of the same-named group must not be credited to the report")

if failures:
    print(f"\nFAIL ({scenario}):\n" + "\n".join(f"  - {f}" for f in failures))
    sys.exit(1)
print(f"\nPASS ({scenario})  run dir: {P.runDir}")
