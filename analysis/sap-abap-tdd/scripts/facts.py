"""Deterministic fact extraction from one run's snapshot.

Input : <run>/src/**/.abap-package.json + the files they list (from `object pull`)
        <run>/bundle/<PKG>/{manifest,metrics,ddic}.json when `context build` succeeded
        <run>/meta/tstc.xml when the T-code → program lookup succeeded
        <run>/meta/transports-{join,e071,e070,e07t}.xml when the transport lookups succeeded
Output: facts.json — every fact carries the object it came from, and code facts
        carry file + line, so a later step can show evidence and a validator can
        reject names that are not in the snapshot.

The scanner is statement-level regex over ABAP with comments removed. It is not
a parser and does not pretend to be one: ambiguous statements (MODIFY/DELETE on
something that may be an internal table) are only counted when the target looks
like a database table.

Regexes use re.ASCII so that \\w, \\b and \\d mean what they mean in ABAP (and in
the JavaScript implementation this was ported from).
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from lib import (
    UNDEF, OrderedSet, assign_nullish, coalesce, fwd, js_key_order, lp, nullish,
    read_json, read_text, safe_folder, serial,
)

A = re.A
CUSTOM_PREFIX = re.compile(r"^(Z|Y|/RB)", re.I | A)
VARIABLE_LIKE = re.compile(r"^(<|[A-Z]{1,2}_|L[A-Z]?_|G[A-Z]?_|M[A-Z]?_|P[A-Z]?_|I[A-Z]?_|E[A-Z]?_|R[A-Z]?_|C[A-Z]?_|ME->)", re.I | A)
SAP_NAME_RE = re.compile(r"/?[A-Za-z0-9_]+(?:/[A-Za-z0-9_]+)*", A)

# SAP-standard members of an SE54-generated table-maintenance function group. The
# generator brings them in under German names that happen to start with Z
# ("zurückholen" = undo, "zweistufig" = two-step), so the Z* / Y* / /RB* filter in
# the connection's pull-config.json lets them through. On /RB4R/MM_AUTOMAT_CLOSING_PO
# they were 1,199 of 3,228 "package" code lines (ZURUECKHOLEN listed twice by
# adt-cli) and put VIEWCLUSTER_UNDO_DEPENDENT into the consumed-functions table.
SAP_STANDARD_MEMBER = re.compile(r"\.fugr\.(zurueckholen|zweistufig)\.abap$", re.I)


def up(s) -> str:
    return str(s).upper()


# ---------------------------------------------------------------------------
# ABAP source → statements
# ---------------------------------------------------------------------------

def _strip_inline_comment(line: str) -> str:
    """Remove a trailing `"` comment, honouring '...', `...` and |...| literals."""
    quote = None
    for i, c in enumerate(line):
        if quote:
            if c == quote:
                quote = None
        elif c in "'`|":
            quote = c
        elif c == '"':
            return line[:i]
    return line


def statements(source: str) -> list[dict]:
    """Split source into `{text, line}` statements (line = 1-based start line)."""
    out = []
    lines = re.split(r"\r?\n", source)
    buf = ""
    start = 0
    ws = re.compile(r"\s+")
    for i, raw in enumerate(lines):
        if raw.startswith("*"):
            continue
        code = _strip_inline_comment(raw)
        if not code.strip():
            continue
        if not buf:
            start = i + 1
        # Split on periods that end a statement: a '.' outside literals followed by
        # whitespace or end of line.
        quote = None
        seg = ""
        n = len(code)
        for j, c in enumerate(code):
            if quote:
                if c == quote:
                    quote = None
                seg += c
                continue
            if c in "'`|":
                quote = c
                seg += c
                continue
            if c == "." and (j == n - 1 or code[j + 1].isspace()):
                buf += " " + seg
                out.append({"text": ws.sub(" ", buf).strip(), "line": start})
                buf = ""
                seg = ""
                start = i + 1
                continue
            seg += c
        if seg.strip():
            if not buf:
                start = i + 1
            buf += " " + seg
    if buf.strip():
        out.append({"text": ws.sub(" ", buf).strip(), "line": start})
    return out


def _looks_like_db_table(name: str, known_tables: set) -> bool:
    n = up(name)
    if n in known_tables:
        return True
    if not SAP_NAME_RE.fullmatch(n) or VARIABLE_LIKE.match(n) or "->" in n or "=>" in n:
        return False
    return len(n) <= 30


# ---------------------------------------------------------------------------
# Inventory
# ---------------------------------------------------------------------------

def _type_priority(type_id: str) -> int:
    """Which object type owns a name shared by several types. Higher wins."""
    t = str(type_id)
    if re.match(r"(CLAS|INTF|PROG|FUGR)", t):
        return 5
    if re.match(r"(TABL|VIEW|DDLS|DCLS)", t):
        return 4
    if t.startswith("TRAN"):
        return 3
    if t.startswith("MSAG"):
        return 2
    return 1


def _join_under(d: str, f: str) -> str:
    """Node's `path.join(dir, f)`: `f` always lands under `dir`.

    adt-cli names namespaced files `/rb4r/x.clas.abap` — with a leading slash. Python's
    os.path.join treats that as absolute and drops `dir`, so every /RB4R/ file resolved
    to C:\\rb4r\\... and the whole package looked empty (live run 4, 2026-09-13).
    """
    return os.path.normpath(d + os.sep + f)


def _load_inventory(P):
    objects: dict = {}
    packages: dict = {}
    skipped: list = []
    if not P.src.exists():
        return objects, packages, skipped
    for entry in os.scandir(P.src):
        if not entry.is_dir():
            continue
        d = entry.path
        manifest = read_json(os.path.join(d, ".abap-package.json"), None)
        if not manifest:
            continue
        pkg_name = up(manifest.get("package"))
        pkg = packages.setdefault(pkg_name, {"name": pkg_name, "subPackages": OrderedSet(), "dirs": []})
        pkg["dirs"].append(d)
        for s in manifest.get("subPackages") or []:
            pkg["subPackages"].add(up(s))
        for item in manifest.get("inventory") or []:
            name = up(item.get("name")).strip()
            type_id = item.get("typeId")
            key = name
            # One name can belong to several object types (a T-code and a message class
            # both called /RB4R/MM_QUOTA). The plain name goes to the type that matters
            # most for lookups by name; the others live under "NAME [TYPE]".
            prev_same = next((o for o in objects.values() if o["name"] == name and o["typeId"] == type_id), None)
            if prev_same is not None:
                # Group pulls list every object in every group; keep the pulled record.
                if prev_same["status"] == "pulled" and item.get("status") != "pulled":
                    continue
                key = next(k for k, v in objects.items() if v is prev_same)
            elif name in objects:
                if _type_priority(type_id) > _type_priority(objects[name]["typeId"]):
                    moved = objects[name]
                    objects[f"{name} [{moved['typeId']}]"] = moved
                else:
                    key = f"{name} [{type_id}]"
            status = item.get("status", UNDEF)
            files, seen = [], set()
            for f in item.get("files") or []:
                p = _join_under(d, f)
                if p in seen:
                    continue  # adt-cli lists some function-group members twice
                seen.add(p)
                if SAP_STANDARD_MEMBER.search(f):
                    skipped.append({"obj": name, "file": fwd(f), "reason": "SAP-standard member of a generated table-maintenance function group"})
                    continue
                files.append(p)
            objects[key] = {
                "name": name,
                "typeId": type_id,
                "package": up(coalesce(item.get("package", UNDEF), pkg_name)),
                "description": coalesce(item.get("description", UNDEF), ""),
                "uri": coalesce(item.get("uri", UNDEF), None),
                "status": status,
                "reason": UNDEF if status == "pulled" else item.get("reason", UNDEF),
                "files": files,
            }
    return objects, packages, skipped


def _adt_attributes(xml: str) -> dict:
    """adtcore attributes of an XML file (responsible, changedAt, description, ...)."""
    out = {}
    for m in re.finditer(r'adtcore:(\w+)="([^"]*)"', xml[:3000], A):
        out.setdefault(m.group(1), m.group(2))
    return out


def _decode_xml(s: str) -> str:
    return (str(s).replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
            .replace("&quot;", '"').replace("&apos;", "'"))


def _new_table(name):
    return {"name": name, "read": [], "write": [], "fields": OrderedSet()}


# Statement patterns, compiled once.
R = {k: re.compile(v, A) for k, v in {
    "class_def": r"CLASS (\S+) DEFINITION\b(.*)$",
    "inherit": r"INHERITING FROM (\S+)",
    "class_impl": r"CLASS \S+ IMPLEMENTATION",
    "interface": r"INTERFACE \S+",
    "section": r"(PUBLIC|PROTECTED|PRIVATE) SECTION",
    "end_class": r"END(CLASS|INTERFACE)",
    "interfaces": r"INTERFACES:? (.+)$",
    "methods": r"(CLASS-)?METHODS:? (.+)$",
    "method": r"METHOD (\S+)",
    "end_unit": r"ENDMETHOD|ENDFUNCTION|ENDFORM",
    "function": r"FUNCTION (\S+)\b(.*)$",
    "form": r"FORM (\S+)",
    "report_msgid": r"REPORT \S+.*MESSAGE-ID (\S+)",
    "include": r"INCLUDE (\S+)",
    "type_ref": r"(\S+) TYPE REF TO (\S+)",
    "type_custom": r"\bTYPE (?:TABLE OF |STANDARD TABLE OF |SORTED TABLE OF |HASHED TABLE OF |RANGE OF )?(/[A-Z0-9_]+/[A-Z0-9_]+|[ZY][A-Z0-9_]+)",
    "select": r"\bSELECT\s+(SINGLE\s+|DISTINCT\s+)?(?:FOR UPDATE\s+)?([\s\S]*?)\s+FROM\s+(?!@|\()([\w/]+)",
    "select_new": r"\bSELECT\s+FROM\s+(?!@|\()([\w/]+)\s+FIELDS\s+([\s\S]*?)\s+(?:WHERE|INTO|ORDER|GROUP|$)",
    "join": r"\bJOIN\s+(?!@|\()([\w/]+)",
    "w_update": r"UPDATE\s+([\w/]+)\s+(SET|FROM)\b",
    "w_insert": r"INSERT\s+(?:INTO\s+)?([\w/]+)\s+(FROM|VALUES)\b",
    "w_modify": r"MODIFY\s+([\w/]+)\s+FROM\s+(TABLE\s+)?(?![\s\S]*\b(INDEX|TRANSPORTING)\b)",
    "w_delete_from": r"DELETE\s+FROM\s+([\w/]+)\b",
    "w_delete": r"DELETE\s+([\w/]+)\s+FROM\s+(TABLE\s+)?[A-Z]",
    "call_function": r"\bCALL FUNCTION '([^']+)'",
    "auth": r"AUTHORITY-CHECK OBJECT '([^']+)'(.*)$",
    "auth_id": r"\bID '([^']+)'",
    "msg_short": r"\bMESSAGE ([AEISWX])(\d{3})\(([^)]+)\)",
    "msg_long": r"\bMESSAGE ID '?([^'\s]+)'? TYPE '?(\w)'? NUMBER '?(\d{3})'?",
    "msg_default": r"MESSAGE ([AEISWX])(\d{3})\b(?!\()",
    "raise": r"\bRAISE EXCEPTION TYPE (\S+)",
    "catch": r"^CATCH (.+)$",
    "get_badi": r"GET BADI (\S+)",
    "call_badi": r"CALL BADI (\S+?)->(\S+)",
    "exithandler": r"CL_EXITHANDLER=>GET_INSTANCE[\s\S]*EXIT_NAME\s*=\s*'([^']+)'",
    "customer_fn": r"CALL CUSTOMER-FUNCTION '([^']+)'",
    "enhancement": r"ENHANCEMENT-(POINT|SECTION) (\S+)",
    "call_tx": r"\b(?:CALL|LEAVE TO) TRANSACTION '?([^'\s]+)'?",
    "submit": r"SUBMIT \(?([\w/]+)\)?",
    "alv": r"CL_SALV_TABLE|CL_GUI_ALV_GRID|CL_SALV_TREE",
    "excel": r"\bZCL_EXCEL\b|\bCL_XLSX_DOCUMENT\b|\bCL_FDT_XL_SPREADSHEET\b",
    "excel_name": r"ZCL_EXCEL|CL_XLSX_DOCUMENT|CL_FDT_XL_SPREADSHEET",
    "bali": r"\bCL_BALI_|\bIF_BALI_",
    "tcode_lit": r"'(/[A-Z0-9_]+/[A-Z0-9_]+|[ZY][A-Z0-9_]+)'",
    "new": r"\bNEW (/[A-Z0-9_]+/[A-Z0-9_]+|[ZY]CL_[A-Z0-9_]+)\(",
    "create_object": r"\bCREATE OBJECT \S+ TYPE (\S+)",
    "static_call": r"(/[A-Z0-9_]+/[A-Z0-9_]+|[ZY]C[LX]_[A-Z0-9_]+)=>",
    # Method calls. A call is `x->m(`, or `CALL METHOD x->m` followed by a parameter
    # keyword or the end of the statement; `x->comp` alone is an attribute access.
    # Chained calls (`a->b->m(`) are not followed: the middle object's type is unknown.
    "inst_call": r"(?<![\w>~-])([A-Z_][A-Z0-9_]*)->([A-Z_][A-Z0-9_]*)(?=\s*\(|\s+(?:EXPORTING|IMPORTING|CHANGING|RECEIVING|EXCEPTIONS)\b|\s*$)",
    "static_method": r"(/[A-Z0-9_]+/[A-Z0-9_]+|[ZY]C[LX]_[A-Z0-9_]+)=>([A-Z_][A-Z0-9_]*)(?=\s*\(|\s+(?:EXPORTING|IMPORTING|CHANGING|RECEIVING|EXCEPTIONS)\b|\s*$)",
    "new_typed": r"\b(?:DATA\(([A-Z_][A-Z0-9_]*)\)|([A-Z_][A-Z0-9_]*))\s*=\s*NEW (/[A-Z0-9_]+/[A-Z0-9_]+|[A-Z][A-Z0-9_]*|#)\(",
    "create_obj_var": r"\bCREATE OBJECT ([A-Z_][A-Z0-9_]*)(?:\s+TYPE (\S+))?",
    # A functional call without a receiver: inside a class, a call of its own method.
    # Built-ins and substring offsets match too; they are dropped after the scan by
    # keeping only names that are methods of the class.
    "bare_call": r"(?<![\w>=~-])([A-Z_][A-Z0-9_]*)\(",
    "cds_source": r"\b(?:from|join|association\s+(?:\[[^\]]*\]\s+)?to)\s+([\w/]+)",
}.items()}
CDS_SOURCE = re.compile(R["cds_source"].pattern, re.I | A)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def build_facts(P, state) -> dict:
    objects, pulled_packages, skipped_files = _load_inventory(P)

    def rel(f):
        return fwd(os.path.relpath(f, P.runDir))

    known_tables = {o["name"] for o in objects.values() if re.match(r"(TABL/DT|VIEW/DV|DDLS)", str(o["typeId"]))}
    tables: dict = {}
    calls: dict = {}
    auth_checks: list = []
    message_use: list = []
    exceptions: dict = {}
    badis: list = []
    transactions_called: list = []
    submits: list = []
    outputs: list = []
    logging: list = []
    locks: list = []
    rfc: list = []
    tcode_literals: list = []
    classes: dict = {}
    interfaces: dict = {}
    function_modules: list = []
    programs: dict = {}
    references: dict = {}  # object → OrderedSet of referenced names
    ref_decls: dict = {}   # object → {variable: class}, from TYPE REF TO and typed NEW / CREATE OBJECT
    raw_calls: list = []   # method calls whose variable is resolved to a class after the scan
    own_calls: dict = {}   # class → {method: OrderedSet of names it calls without a receiver}
    code_lines = 0

    tcode_names = {o["name"] for o in objects.values() if o["typeId"] == "TRAN/T"}

    def add_ref(obj, name):
        if not name:
            return
        references.setdefault(obj, OrderedSet()).add(up(name))

    # `unit` is the method / function module / FORM the statement sits in; the scan
    # loop updates it before each statement so every evidence record carries it.
    ev = {"unit": None}

    def evidence(obj, file, line, extra=None):
        rec = {"obj": obj}
        if ev["unit"]:
            rec["unit"] = ev["unit"]
        rec["file"] = rel(file)
        rec["line"] = line
        if extra:
            rec.update(extra)
        return rec

    for obj in list(objects.values()):
        if obj["status"] != "pulled":
            continue
        for file in obj["files"]:
            if not os.path.exists(lp(file)):
                continue
            text = read_text(file)

            if file.endswith(".xml"):
                attrs = _adt_attributes(text)
                for k in ("responsible", "createdBy", "createdAt", "changedBy", "changedAt"):
                    assign_nullish(obj, k, attrs.get(k, UNDEF))
                if obj["typeId"] == "MSAG/N":
                    msgs = {}
                    for m in re.finditer(r'mc:msgno="(\d+)"\s+mc:msgtext="([^"]*)"', text, A):
                        msgs[m.group(1)] = _decode_xml(m.group(2))
                    obj["messages"] = js_key_order(msgs)
                continue
            if not (file.endswith(".abap") or file.endswith(".asddls") or file.endswith(".asdcls")):
                continue

            n_lines = len(re.split(r"\r?\n", text))
            code_lines += n_lines

            if file.endswith(".asddls"):
                for m in CDS_SOURCE.finditer(text):
                    t = up(m.group(1))
                    tables.setdefault(t, _new_table(t))["read"].append(evidence(obj["name"], file, 0, {"via": "CDS"}))
                    add_ref(obj["name"], t)
                continue

            # Per-file context: which method / function module a statement sits in,
            # and which variables are typed as BAdI references.
            current_unit = None
            class_section = None
            in_definition = False
            ref_types: dict = {}
            is_class_file = obj["typeId"] == "CLAS/OC"
            is_intf_file = obj["typeId"] == "INTF/OI"
            cls = classes.setdefault(obj["name"], {
                "name": obj["name"], "package": obj["package"], "description": obj["description"],
                "superClass": None, "interfaces": [], "methods": [], "collaborators": OrderedSet(), "file": rel(file), "loc": 0,
            }) if is_class_file else None
            intf = interfaces.setdefault(obj["name"], {
                "name": obj["name"], "package": obj["package"], "description": obj["description"], "methods": [], "file": rel(file),
            }) if is_intf_file else None
            if cls is not None:
                cls["loc"] += n_lines
            if obj["typeId"] in ("PROG/P", "PROG/I"):
                programs.setdefault(obj["name"], {
                    "name": obj["name"], "package": obj["package"], "typeId": obj["typeId"], "description": obj["description"],
                    "parameters": 0, "selectOptions": 0, "screens": OrderedSet(), "forms": 0, "includes": [], "messageId": None, "file": rel(file),
                    "loc": n_lines,
                })
            prog = programs.get(obj["name"])

            for st in statements(text):
                S = up(st["text"])
                line = st["line"]
                where = obj["name"]
                ev["unit"] = current_unit

                # --- structure -----------------------------------------------------
                m = R["class_def"].match(S)
                if m:
                    in_definition = up(m.group(1)) == obj["name"] or is_class_file
                    inh = R["inherit"].search(m.group(2))
                    if cls is not None and inh and up(m.group(1)) == obj["name"]:
                        cls["superClass"] = up(inh.group(1))
                        add_ref(obj["name"], inh.group(1))
                    continue
                if R["class_impl"].fullmatch(S):
                    in_definition = False
                    continue
                if R["interface"].match(S) and not re.search(r"DEFERRED|LOAD", S):
                    in_definition = True
                    continue
                m = R["section"].fullmatch(S)
                if m:
                    class_section = m.group(1).lower()
                    continue
                if R["end_class"].fullmatch(S):
                    in_definition = False
                    continue
                m = R["interfaces"].match(S)
                if m and in_definition:
                    for nm in (x for x in re.split(r"[\s,]+", m.group(1)) if SAP_NAME_RE.fullmatch(x)):
                        if cls is not None:
                            cls["interfaces"].append(up(nm))
                        add_ref(obj["name"], nm)
                    continue
                m = R["methods"].match(S)
                if m and in_definition:
                    for part in re.split(r",(?![^(]*\))", m.group(2)):
                        words = part.strip().split()
                        name = words[0] if words else ""
                        if not name or not re.fullmatch(r"[A-Z_~/0-9]+", name):
                            continue
                        rec = {"name": name, "visibility": "public" if is_intf_file else class_section,
                               "static": bool(m.group(1)), "redefinition": bool(re.search(r"\bREDEFINITION\b", part, A))}
                        if cls is not None:
                            cls["methods"].append(rec)
                        if intf is not None:
                            intf["methods"].append(rec)
                    continue
                m = R["method"].fullmatch(S)
                if m:
                    current_unit = m.group(1)
                    continue
                if R["end_unit"].fullmatch(S):
                    current_unit = None
                    continue
                m = R["function"].match(S)
                if m:
                    current_unit = up(m.group(1))
                    params = {"importing": [], "exporting": [], "changing": [], "tables": [], "exceptions": []}
                    section = None
                    for tok in re.split(r"\s+", m.group(2)):
                        if re.fullmatch(r"IMPORTING|EXPORTING|CHANGING|TABLES|EXCEPTIONS|RAISING", tok):
                            section = tok.lower()
                            continue
                        p = re.fullmatch(r"(?:VALUE|REFERENCE)\((\w+)\)", tok, A) or (re.fullmatch(r"(\w+)", tok, A) if section == "exceptions" else None)
                        if p and section and section in params:
                            params[section].append(p.group(1))
                    function_modules.append({"name": current_unit, "group": obj["name"], "package": obj["package"], "params": params, "file": rel(file), "line": line})
                    continue
                m = R["form"].match(S)
                if m:
                    current_unit = f"FORM {m.group(1)}"
                    if prog is not None:
                        prog["forms"] += 1
                    continue
                if prog is not None:
                    m = R["report_msgid"].match(S)
                    if m:
                        prog["messageId"] = up(m.group(1))
                    if re.match(r"PARAMETERS\b", S, A):
                        prog["parameters"] += len(S.split(",")) if re.match(r"PARAMETERS:?", S).group(0).endswith(":") else 1
                    if re.match(r"SELECT-OPTIONS\b", S, A):
                        prog["selectOptions"] += len(S.split(",")) if S.startswith("SELECT-OPTIONS:") else 1
                    for scr in re.finditer(r"\bCALL SCREEN (\d+)", S, A):
                        prog["screens"].add(scr.group(1))
                    m = R["include"].fullmatch(S)
                    if m and not S.startswith("INCLUDE TYPE") and not S.startswith("INCLUDE STRUCTURE"):
                        prog["includes"].append(up(m.group(1)))

                # --- declarations: remember BAdI-typed references --------------------
                for d in R["type_ref"].finditer(S):
                    v = re.sub(r"^DATA:?|^CLASS-DATA:?", "", d.group(1), count=1)
                    v = re.sub(r",$", "", v, count=1).strip()
                    target = re.sub(r"[,.]$", "", up(d.group(2)), count=1)
                    # `TYPE REF TO data` / `object` are generic references, not collaborators.
                    if target in ("DATA", "OBJECT"):
                        continue
                    ref_types[v] = target
                    ref_decls.setdefault(obj["name"], {})[v] = target
                    add_ref(obj["name"], target)
                    if cls is not None and target != obj["name"]:
                        cls["collaborators"].add(target)
                for t in R["type_custom"].finditer(S):
                    add_ref(obj["name"], t.group(1))

                # --- database access ------------------------------------------------
                if re.match(r"SELECT\b", S, A) or re.match(r"OPEN CURSOR\b", S, A) or (re.search(r"\bSELECT\b", S, A) and re.search(r"\bFROM\b", S, A)):
                    mm = R["select"].search(S)
                    if mm:
                        t = mm.group(3)
                        # Old syntax may put INTO / APPENDING before FROM; the field list ends there.
                        fields_raw = re.split(r"\s+(?:INTO|APPENDING)\b", mm.group(2), flags=A)[0].strip()
                        rec = tables.setdefault(t, _new_table(t))
                        rec["read"].append(evidence(where, file, line))
                        if fields_raw in ("*", ""):
                            rec["fields"].add("*")
                        elif not re.match(r"(COUNT|MAX|MIN|SUM|AVG)\(", fields_raw):
                            for f in re.split(r"[\s,]+", fields_raw):
                                if re.fullmatch(r"[A-Z][A-Z0-9_~]*", f) and f not in ("AS", "INTO"):
                                    rec["fields"].add(re.sub(r"^.*~", "", f, count=1))
                        add_ref(obj["name"], t)
                    fn = R["select_new"].search(S)
                    if fn:
                        rec = tables.setdefault(fn.group(1), _new_table(fn.group(1)))
                        rec["read"].append(evidence(where, file, line))
                        for f in re.split(r"[\s,]+", fn.group(2)):
                            if re.fullmatch(r"[A-Z][A-Z0-9_~]*", f):
                                rec["fields"].add(re.sub(r"^.*~", "", f, count=1))
                    for j in R["join"].finditer(S):
                        tables.setdefault(j.group(1), _new_table(j.group(1)))["read"].append(evidence(where, file, line, {"via": "JOIN"}))
                        add_ref(obj["name"], j.group(1))
                w = (R["w_update"].match(S) or R["w_insert"].match(S) or R["w_modify"].match(S)
                     or R["w_delete_from"].match(S) or R["w_delete"].match(S))
                if w and _looks_like_db_table(w.group(1), known_tables) and w.group(1) != "TABLE":
                    t = up(w.group(1))
                    op = S.split(" ")[0]
                    tables.setdefault(t, _new_table(t))["write"].append(evidence(where, file, line, {"op": op}))
                    add_ref(obj["name"], t)

                # --- calls ------------------------------------------------------------
                m = R["call_function"].search(S)
                if m:
                    fm = m.group(1).strip()
                    rec = calls.setdefault(fm, {"name": fm, "callers": [], "updateTask": False, "rfc": False, "newTask": False})
                    rec["callers"].append(evidence(where, file, line))
                    if "IN UPDATE TASK" in S:
                        rec["updateTask"] = True
                    if re.search(r"\bDESTINATION\b", S, A):
                        rec["rfc"] = True
                        rfc.append(evidence(where, file, line, {"fm": fm}))
                    if "STARTING NEW TASK" in S:
                        rec["newTask"] = True
                    if re.match(r"(ENQUEUE|DEQUEUE)_", fm):
                        locks.append(evidence(where, file, line, {"fm": fm}))
                    if fm.startswith("BAL_"):
                        logging.append(evidence(where, file, line, {"via": fm}))
                    if fm in ("FP_JOB_OPEN", "FP_FUNCTION_MODULE_NAME"):
                        outputs.append(evidence(where, file, line, {"kind": "Adobe Form", "via": fm}))
                    if fm == "SSF_FUNCTION_MODULE_NAME":
                        outputs.append(evidence(where, file, line, {"kind": "Smart Form", "via": fm}))
                    if fm in ("OPEN_FORM", "WRITE_FORM"):
                        outputs.append(evidence(where, file, line, {"kind": "SAPscript", "via": fm}))
                    if fm in ("GUI_DOWNLOAD", "GUI_UPLOAD", "ALSM_EXCEL_TO_INTERNAL_TABLE", "TEXT_CONVERT_XLS_TO_SAP"):
                        outputs.append(evidence(where, file, line, {"kind": "File / Excel", "via": fm}))
                    if fm.startswith("REUSE_ALV"):
                        outputs.append(evidence(where, file, line, {"kind": "ALV list", "via": fm}))
                    if fm == "AUTHORITY_CHECK_TCODE":
                        auth_checks.append(evidence(where, file, line, {"object": "S_TCODE", "fields": ["TCD"], "via": fm}))
                    add_ref(obj["name"], fm)
                m = R["auth"].match(S)
                if m:
                    fields = [x.group(1) for x in R["auth_id"].finditer(m.group(2))]
                    auth_checks.append(evidence(where, file, line, {"object": m.group(1), "fields": fields}))
                for mc in R["msg_short"].finditer(S):
                    message_use.append(evidence(where, file, line, {"cls": up(mc.group(3)), "no": mc.group(2), "type": mc.group(1)}))
                m = R["msg_long"].search(S)
                if m:
                    message_use.append(evidence(where, file, line, {"cls": up(m.group(1)), "no": m.group(3), "type": m.group(2)}))
                m = R["msg_default"].match(S)
                if m and prog is not None and prog["messageId"]:
                    message_use.append(evidence(where, file, line, {"cls": prog["messageId"], "no": m.group(2), "type": m.group(1)}))
                for x in R["raise"].finditer(S):
                    exceptions.setdefault(up(x.group(1)), []).append(evidence(where, file, line, {"raised": True}))
                for x in R["catch"].finditer(S):
                    for cx in (n for n in re.split(r"\s+", x.group(1)) if "CX" in n and n != "INTO"):
                        exceptions.setdefault(up(cx), []).append(evidence(where, file, line, {"caught": True}))

                m = R["get_badi"].match(S)
                if m:
                    badis.append(evidence(where, file, line, {"badi": coalesce(ref_types.get(m.group(1), UNDEF), None), "kind": "GET BADI", "variable": m.group(1)}))
                m = R["call_badi"].match(S)
                if m:
                    badis.append(evidence(where, file, line, {"badi": coalesce(ref_types.get(m.group(1), UNDEF), None), "kind": "CALL BADI", "method": m.group(2)}))
                m = R["exithandler"].search(S)
                if m:
                    badis.append(evidence(where, file, line, {"badi": up(m.group(1)), "kind": "classic BAdI"}))
                m = R["customer_fn"].match(S)
                if m:
                    badis.append(evidence(where, file, line, {"badi": f"customer function {m.group(1)}", "kind": "user exit"}))
                m = R["enhancement"].match(S)
                if m:
                    badis.append(evidence(where, file, line, {"badi": up(m.group(2)), "kind": f"enhancement {m.group(1).lower()}"}))

                m = R["call_tx"].search(S)
                if m:
                    transactions_called.append(evidence(where, file, line, {"tcode": up(m.group(1))}))
                m = R["submit"].match(S)
                if m:
                    submits.append(evidence(where, file, line, {"program": up(m.group(1))}))
                m = R["alv"].search(S)
                if m:
                    outputs.append(evidence(where, file, line, {"kind": "ALV list", "via": m.group(0)}))
                if R["excel"].search(S):
                    outputs.append(evidence(where, file, line, {"kind": "Excel (xlsx)", "via": R["excel_name"].search(S).group(0)}))
                if R["bali"].search(S):
                    logging.append(evidence(where, file, line, {"via": "BALI"}))
                for lit in R["tcode_lit"].finditer(S):
                    if lit.group(1) in tcode_names:
                        tcode_literals.append(evidence(where, file, line, {"tcode": lit.group(1)}))

                for pat in ("new", "create_object", "static_call"):
                    for x in R[pat].finditer(S):
                        add_ref(obj["name"], x.group(1))
                        if cls is not None and up(x.group(1)) != obj["name"]:
                            cls["collaborators"].add(up(x.group(1)))

                # --- method calls, kept raw. The variable is resolved to its class after
                # the scan: a report declares it in one include (TOP) and calls it from
                # another (I01), and `ref_types` above lives for one file only.
                def own_call(name):
                    if cls is not None and current_unit:
                        own_calls.setdefault(obj["name"], {}).setdefault(current_unit, OrderedSet()).add(name)

                for x in R["inst_call"].finditer(S):
                    if x.group(1) == "ME":
                        own_call(x.group(2))
                    else:
                        raw_calls.append({**evidence(where, file, line), "var": x.group(1), "method": x.group(2)})
                for x in R["static_method"].finditer(S):
                    if up(x.group(1)) == obj["name"]:
                        own_call(x.group(2))
                    else:
                        raw_calls.append({**evidence(where, file, line), "class": up(x.group(1)), "method": x.group(2)})
                m = R["new_typed"].search(S)
                if m:
                    var = m.group(1) or m.group(2)
                    if m.group(3) != "#":
                        ref_decls.setdefault(obj["name"], {})[var] = up(m.group(3))
                    raw_calls.append({**evidence(where, file, line), "var": var, "method": "CONSTRUCTOR"})
                m = R["create_obj_var"].search(S)
                if m:
                    if m.group(2):
                        ref_decls.setdefault(obj["name"], {})[m.group(1)] = re.sub(r"[,.]$", "", up(m.group(2)))
                    raw_calls.append({**evidence(where, file, line), "var": m.group(1), "method": "CONSTRUCTOR"})
                if cls is not None and current_unit:
                    for x in R["bare_call"].finditer(S):
                        own_call(x.group(1))

    ev["unit"] = None

    # A report's selection screen and dynpro logic usually live in its includes;
    # credit them to the report so its entry-point summary is complete.
    for p in [x for x in programs.values() if x["typeId"] == "PROG/P"]:
        for inc in p["includes"]:
            i = programs.get(inc)
            if not i:
                continue
            p["parameters"] += i["parameters"]
            p["selectOptions"] += i["selectOptions"]
            for scr in i["screens"]:
                p["screens"].add(scr)
            p["forms"] += i["forms"]
            assign_nullish(p, "messageId", i["messageId"])

    # --- method calls: variables resolved across a report and its includes ---------
    included_by: dict = {}
    for p in programs.values():
        for inc in p["includes"]:
            if p["name"] not in included_by.setdefault(inc, []):
                included_by[inc].append(p["name"])

    def family(name):
        """The object, every report that includes it, and all their includes."""
        out, todo = [], [name, *included_by.get(name, [])]
        while todo:
            n = todo.pop(0)
            if n in out:
                continue
            out.append(n)
            todo.extend((programs.get(n) or {}).get("includes", []))
        return out

    class_names = set(classes) | set(interfaces)
    method_calls = []
    for c in raw_calls:
        target = c.get("class") or next(
            (ref_decls[o][c["var"]] for o in family(c["obj"]) if c["var"] in ref_decls.get(o, {})), None)
        if not target or target not in class_names:
            continue
        rec = {k: v for k, v in c.items() if k != "var"}
        rec["class"] = target
        method_calls.append(rec)

    # --- calls of a class's own methods, so a step can be credited with what the
    # private methods it calls do --------------------------------------------------
    unit_calls: dict = {}
    for cname, units in own_calls.items():
        known_methods = {m["name"] for m in (classes.get(cname) or {}).get("methods", [])}
        for unit, called in units.items():
            keep = [n for n in called if n in known_methods and n != unit]
            if keep:
                unit_calls.setdefault(cname, {})[unit] = keep

    # --- context bundle: metrics + object metadata, names re-qualified -------------
    by_short = {}
    for name in objects:
        by_short[re.sub(r"^/[^/]+/", "", name, count=1)] = name

    def qualify(n):
        u = up(n)
        return u if u in objects else by_short.get(u, u)

    metrics = {}
    ddic_fields: dict = {}     # table / structure / view → its fields, from ddic.json
    data_elements: dict = {}   # data element → domain, type, length
    for pkg_name in list(pulled_packages):
        d = P.bundle / safe_folder(pkg_name)
        man = read_json(d / "manifest.json", None)
        for o in (man or {}).get("objects") or []:
            obj = objects.get(qualify(o.get("name")))
            if not obj:
                continue
            for k in ("responsible", "createdAt", "changedBy", "changedAt"):
                v = o.get(k)
                assign_nullish(obj, k, UNDEF if nullish(v) else v)
        dd = read_json(d / "ddic.json", None) or {}
        for group in ("tables", "structures", "views"):
            for t in dd.get(group) or []:
                ddic_fields[qualify(t.get("name"))] = [
                    {k: f.get(k) for k in ("name", "dataType", "length", "decimals", "isKey", "description")}
                    for f in t.get("fields") or []]
        for e in dd.get("dataElements") or []:
            data_elements[qualify(e.get("name"))] = {k: e.get(k) for k in ("description", "domain", "dataType", "length", "decimals")}
        met = read_json(d / "metrics.json", None)
        for c in (met or {}).get("classes") or []:
            metrics[qualify(c.get("name"))] = {
                "methodCount": c.get("methodCount", UNDEF), "maxComplexity": c.get("maxComplexity", UNDEF),
                "maxMethodLength": c.get("maxMethodLength", UNDEF), "isGodClass": c.get("isGodClass", UNDEF),
                "top": (c.get("methods") or [])[:5],
            }
        if man:
            pulled_packages[pkg_name]["bundleMeta"] = {k: man.get(k, UNDEF) for k in (
                "description", "responsible", "softwareComponent", "applicationComponent", "transportLayer", "changedAt")}

    # --- T-code → program --------------------------------------------------------
    tstc = _parse_tstc(P.meta / "tstc.xml")
    tcodes = []
    for o in (x for x in objects.values() if x["typeId"] == "TRAN/T"):
        checked = {}
        for e in (e for e in tcode_literals if e["tcode"] == o["name"]):
            checked[f"{e['obj']}|{e.get('unit') or ''}"] = {"obj": e["obj"], "unit": e.get("unit", UNDEF), "file": e["file"], "line": e["line"]}
        t = tstc.get(o["name"]) or {}
        tcodes.append({
            "name": o["name"], "package": o["package"], "description": o["description"],
            "program": coalesce(t.get("program", UNDEF), None), "screen": coalesce(t.get("screen", UNDEF), None),
            "checkedIn": list(checked.values()),
        })

    transports = _parse_transports(P.meta)
    # Read-but-empty and not-read-at-all read differently in the release notes.
    # Read = an answer arrived: the join, the fallback's E070, or an E071 without any entry.
    e071 = read_preview(P.meta / "transports-e071.xml")
    transports_read = (read_preview(P.meta / "transports-join.xml") is not None
                       or read_preview(P.meta / "transports-e070.xml") is not None
                       or (e071 is not None and not e071.get("TRKORR")))

    # --- package dependency edges via references -----------------------------------
    package_edges = {}
    external_custom = {}
    for frm, refs in references.items():
        from_pkg = objects[frm]["package"] if frm in objects else UNDEF
        for r in refs:
            target = objects.get(r)
            if target and target["package"] != from_pkg:
                k = f"{'undefined' if from_pkg is UNDEF else from_pkg}|{target['package']}"
                package_edges[k] = package_edges.get(k, 0) + 1
            elif not target and CUSTOM_PREFIX.match(r) and r not in tables and r not in calls:
                external_custom.setdefault(r, OrderedSet()).add(from_pkg)

    # --- package list in walk order --------------------------------------------------
    pkg_list = []
    for name, rec in state["packages"].items():
        inv = [o for o in objects.values() if o["package"] == name]
        by_type = {}
        for o in inv:
            by_type[o["typeId"]] = by_type.get(o["typeId"], 0) + 1
        bm = (pulled_packages.get(name) or {}).get("bundleMeta") or {}
        pkg_list.append({
            "name": name,
            "parent": rec.get("parent"),
            "depth": rec.get("depth"),
            "description": coalesce(bm.get("description", UNDEF), rec.get("description", UNDEF), None),
            "responsible": coalesce(bm.get("responsible", UNDEF), None),
            "softwareComponent": coalesce(bm.get("softwareComponent", UNDEF), None),
            "applicationComponent": coalesce(bm.get("applicationComponent", UNDEF), None),
            # From the discovered tree, not the pull manifest: with --depth 0 its
            # `subPackages` is always empty (see next.py step 1a).
            "subPackages": [n for n, r in state["packages"].items() if r.get("parent") == name],
            "objectCount": len(inv),
            "pulled": sum(1 for o in inv if o["status"] == "pulled"),
            "failed": sum(1 for o in inv if o["status"] == "fetch-failed"),
            "byType": by_type,
            "hasCode": bool(rec.get("hasCode")),
            "bundle": coalesce(rec.get("bundle", UNDEF), None),
        })

    # --- messages: definitions joined with use ------------------------------------
    messages = {}
    for o in (x for x in objects.values() if x["typeId"] == "MSAG/N"):
        messages[o["name"]] = {"name": o["name"], "package": o["package"], "description": o["description"],
                               "texts": coalesce(o.get("messages", UNDEF), {}), "used": []}
    for u in message_use:
        messages.setdefault(u["cls"], {"name": u["cls"], "package": None, "description": None, "texts": {}, "used": []})["used"].append(u)

    # --- enhancement objects listed by SAP but not pullable ------------------------
    enhancement_objects = [
        {"name": o["name"], "typeId": o["typeId"], "package": o["package"], "description": o["description"], "uri": o["uri"]}
        for o in objects.values() if re.match(r"(ENHO|ENHS|ENHC|SXCI|SXSD|CMOD|BADI)", str(o["typeId"]))
    ]

    fm_names = {f["name"] for f in function_modules}
    return serial({
        "schema": 1,
        "system": state["system"],
        "root": state["package"],
        "runId": state["runId"],
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "degradations": state["degradations"],
        "totals": {
            "packages": len(pkg_list),
            "objects": len(objects),
            "pulled": sum(1 for o in objects.values() if o["status"] == "pulled"),
            "failed": sum(1 for o in objects.values() if o["status"] == "fetch-failed"),
            "codeLines": code_lines,
        },
        "packages": pkg_list,
        "objects": objects,
        "classes": {k: {**c, "metrics": metrics.get(k)} for k, c in classes.items()},
        "interfaces": interfaces,
        "programs": programs,
        "functionModules": function_modules,
        "tcodes": tcodes,
        "tables": {k: {**t, "custom": bool(CUSTOM_PREFIX.match(k)), "inSnapshot": k in objects,
                       "description": coalesce(objects[k].get("description", UNDEF) if k in objects else UNDEF, None)}
                   for k, t in tables.items()},
        "calls": {k: {**c, "custom": bool(CUSTOM_PREFIX.match(k)), "inSnapshot": k in fm_names} for k, c in calls.items()},
        "authChecks": auth_checks,
        "messages": messages,
        "exceptions": exceptions,
        "badis": badis,
        "enhancementObjects": enhancement_objects,
        "transactionsCalled": transactions_called,
        "submits": submits,
        "outputs": outputs,
        "logging": logging,
        "locks": locks,
        "rfc": rfc,
        "packageEdges": [{"from": k.split("|")[0], "to": k.split("|")[1], "count": n} for k, n in package_edges.items()],
        "externalCustom": {k: list(v) for k, v in external_custom.items()},
        "methodCalls": method_calls,
        "unitCalls": unit_calls,
        "includedBy": included_by,
        "ddicFields": ddic_fields,
        "dataElements": data_elements,
        "transports": transports,
        "transportsRead": transports_read,
        "skippedFiles": skipped_files,
    })


def _parse_tstc(file: Path) -> dict:
    """Parse the TSTC lookup: `adt --raw data sql` saved to a file.

    With --raw that is the ADT data-preview XML, which is column-oriented — one
    <dataPreview:columns> per field, each holding its values in row order. JSON rows
    and plain text tables are accepted as a fallback in case the call is made without
    --raw.
    """
    out = {}
    if not file.exists():
        return out
    text = read_text(file)
    if "<dataPreview:" in text:
        cols = datapreview_columns(text)
        pg = cols.get("PGMNA") or []
        dy = cols.get("DYPNO") or []
        for i, t in enumerate(cols.get("TCODE") or []):
            out[up(t)] = {"program": (pg[i] if i < len(pg) else "") or None, "screen": (dy[i] if i < len(dy) else "") or None}
        return out
    try:
        data = json.loads(text)
        rows = data if isinstance(data, list) else (data.get("rows") or data.get("data") or data.get("values") or [])
        for r in rows:
            tcode = coalesce(r.get("TCODE"), r.get("tcode"), None)
            if tcode:
                out[up(tcode).strip()] = {
                    "program": str(coalesce(r.get("PGMNA"), r.get("pgmna"), "")).strip() or None,
                    "screen": str(coalesce(r.get("DYPNO"), r.get("dypno"), "")).strip() or None,
                }
        if out:
            return out
    except (ValueError, AttributeError):
        pass  # text table
    for line in re.split(r"\r?\n", text):
        cells = [c.strip() for c in re.split(r"[|\t]| {2,}", line) if c.strip()]
        if len(cells) >= 2 and re.fullmatch(r"/[A-Z0-9_]+/[A-Z0-9_]+|[ZY][A-Z0-9_]+", cells[0]):
            out[cells[0]] = {"program": cells[1] or None, "screen": cells[2] if len(cells) > 2 else None}
    return out


def datapreview_columns(text: str) -> dict:
    """ADT data-preview XML (`adt --raw data sql`) → {column: [values in row order]}.

    The format is column-oriented: one <dataPreview:columns> per field. A qualified
    column name (`E070~TRKORR`) keeps only its field part.
    """
    cols = {}
    for m in re.finditer(r"<dataPreview:columns>([\s\S]*?)</dataPreview:columns>", text):
        nm = re.search(r'dataPreview:name="([^"]+)"', m.group(1))
        cols[re.sub(r"^.*~", "", up(nm.group(1) if nm else ""))] = [
            _decode_xml(x.group(1) or "").strip()
            for x in re.finditer(r"<dataPreview:data>([\s\S]*?)</dataPreview:data>|<dataPreview:data/>", m.group(1))
        ]
    return cols


def read_preview(file: Path) -> dict | None:
    """Columns of a saved data preview, or None when the file is missing or holds an error."""
    if not file.exists():
        return None
    text = read_text(file)
    return datapreview_columns(text) if "<dataPreview:" in text else None


def _cell(cols, key, i) -> str:
    values = (cols or {}).get(key) or []
    return values[i].strip() if i < len(values) else ""


def _as4date(value: str) -> str:
    if re.fullmatch(r"\d{8}", value) and value != "00000000":
        return f"{value[:4]}-{value[4:6]}-{value[6:]}"
    return value if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) else ""


def _parse_transports(meta: Path) -> list:
    """Released transport requests that carry the package object, newest first.

    next.py step 1c saves them in one of two shapes: the join E071 (R3TR DEVC
    <package>) → E070 (TRFUNCTION K/W, TRSTATUS R) in `transports-join.xml`, or, when
    the data preview refuses the join, the same rows from two single-table lookups
    (`transports-e071.xml`, then `transports-e070.xml` already filtered to released
    K/W requests). E07T adds the short texts and is optional.
    """
    rows = read_preview(meta / "transports-join.xml") or read_preview(meta / "transports-e070.xml")
    if not rows:
        return []
    e07t = read_preview(meta / "transports-e07t.xml") or {}

    texts = {}
    for i in range(len(e07t.get("TRKORR") or [])):
        key, lang, text = up(_cell(e07t, "TRKORR", i)), up(_cell(e07t, "LANGU", i)), _cell(e07t, "AS4TEXT", i)
        # A request carries its text in several languages; English wins, else the first one.
        if key and text and (key not in texts or (lang == "E" and texts[key][0] != "E")):
            texts[key] = (lang, text)

    requests = {}
    for i in range(len(rows.get("TRKORR") or [])):
        req = up(_cell(rows, "TRKORR", i))
        if not req:
            continue
        # A join row repeats per E071 entry of the package on the same request.
        r = requests.setdefault(req, {"request": req, "date": "", "users": OrderedSet(), "text": (texts.get(req) or ("", ""))[1]})
        date = _as4date(_cell(rows, "AS4DATE", i))
        if date > r["date"]:
            r["date"] = date
        if _cell(rows, "AS4USER", i):
            r["users"].add(_cell(rows, "AS4USER", i))
    return sorted(requests.values(), key=lambda r: (r["date"], r["request"]), reverse=True)
