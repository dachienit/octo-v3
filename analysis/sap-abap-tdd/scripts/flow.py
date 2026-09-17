"""The package's data flow, derived from facts.json.

Shared by compose.py (the Data Flow Diagram and its step tables) and packets.py (the
facts handed to the model for the optional introduction).

A chain starts at one entry point — a report, with the transaction codes that start
it, or a function module the package offers — and lists the class methods it calls,
in call order. Each step carries what it does to data: tables read and written, SAP
functions that change data, output (ALV, e-mail) and authorization checks. A step is
credited with what the private methods it calls inside its class do, so a public
method that only delegates still shows its real effect.

Everything here is already in facts.json with the object and the method it came
from (`obj` / `unit` on every evidence record); this module only groups it.
"""

from __future__ import annotations

import re

GENERATED_FUGR = re.compile(r"Extended Table Maintenance|Generated", re.I)
MAIL_FMS = {"SO_NEW_DOCUMENT_SEND_API1", "SO_NEW_DOCUMENT_ATT_SEND_API1", "SO_DOCUMENT_SEND_API1", "SO_OBJECT_SEND"}
COMMIT_FMS = {"BAPI_TRANSACTION_COMMIT", "BAPI_TRANSACTION_ROLLBACK", "DB_COMMIT"}
# A BAPI whose name says it only reads. Everything else named BAPI_* is taken to change data.
READ_ONLY_BAPI = re.compile(r"GET|READ|LIST|EXIST|CHECK|DISPLAY", re.I)
EFFECT_KINDS = ("reads", "writes", "changes", "calls", "commits", "alv", "mail", "outputs", "auth")


def empty_effects() -> dict:
    return {k: [] for k in EFFECT_KINDS}


def is_empty(eff: dict) -> bool:
    return not any(eff[k] for k in EFFECT_KINDS)


def _add(eff: dict, kind: str, value) -> None:
    if value and value not in eff[kind]:
        eff[kind].append(value)


def merge(dst: dict, src: dict) -> dict:
    for k in EFFECT_KINDS:
        for v in src[k]:
            _add(dst, k, v)
    return dst


def fm_kind(name: str, call: dict) -> str | None:
    """How a called function module shows up in the data flow (None: not at all)."""
    if name in MAIL_FMS:
        return "mail"
    if name.startswith("REUSE_ALV"):
        return "alv"
    if name in COMMIT_FMS:
        return "commits"
    if re.match(r"(ENQUEUE|DEQUEUE)_", name):
        return None  # locks move no data; the APIs chapter lists them
    if call.get("updateTask") or (name.startswith("BAPI_") and not READ_ONLY_BAPI.search(name[5:])):
        return "changes"
    return "calls"


def _index(facts) -> dict:
    """(object, unit) → effects, from every evidence record in the facts."""
    idx: dict = {}

    def add(e, kind, value):
        _add(idx.setdefault((e["obj"], e.get("unit")), empty_effects()), kind, value)

    for t in facts["tables"].values():
        for e in t["read"]:
            add(e, "reads", t["name"])
        for e in t["write"]:
            add(e, "writes", t["name"])
    for c in facts["calls"].values():
        kind = fm_kind(c["name"], c)
        if kind:
            for e in c["callers"]:
                add(e, kind, c["name"])
    for o in facts["outputs"]:
        if o["kind"] == "ALV list":
            add(o, "alv", o.get("via") or "ALV")
        else:
            add(o, "outputs", o["kind"])
    for a in facts["authChecks"]:
        add(a, "auth", a["object"])
    return idx


def build_flow(facts) -> list[dict]:
    """Entry-point chains: [{kind, name, description, tcodes, own, steps}].

    `own` is what the entry point does itself (a report together with its includes,
    or the function module's body); `steps` are the class methods it calls, in call
    order, each with the effects of the method and the private methods below it.
    """
    idx = _index(facts)
    programs = facts["programs"]
    unit_calls = facts.get("unitCalls") or {}
    # A function group and a report can share a name (/RB4R/MM_PO_CLOSED is both), and
    # evidence names only the object. A function module's body belongs to its own
    # chain, never to the report of the same name.
    fm_units = {(f["group"], f["name"]) for f in facts["functionModules"]}

    def unit_effects(cls, method):
        eff, todo, seen = empty_effects(), [method], set()
        while todo:
            m = todo.pop(0)
            if m in seen:
                continue
            seen.add(m)
            merge(eff, idx.get((cls, m)) or empty_effects())
            todo.extend(unit_calls.get(cls, {}).get(m, []))
        return eff

    def family(root):
        out, todo = [], [root]
        while todo:
            n = todo.pop(0)
            if n in out:
                continue
            out.append(n)
            todo.extend((programs.get(n) or {}).get("includes", []))
        return out

    calls_by_obj: dict = {}
    for c in facts.get("methodCalls") or []:
        calls_by_obj.setdefault(c["obj"], []).append(c)

    def steps_of(sources):
        """Class methods called from `sources` — [(object, unit or None for all)] — in call order."""
        steps, seen = [], set()
        for obj, unit in sources:
            for c in sorted(calls_by_obj.get(obj, []), key=lambda c: (c["file"], c["line"])):
                if unit is not None and c.get("unit") != unit:
                    continue
                if unit is None and (obj, c.get("unit")) in fm_units:
                    continue
                key = (c["class"], c["method"])
                if key in seen:
                    continue
                seen.add(key)
                eff = unit_effects(*key)
                # `NEW #( )` is recorded as a CONSTRUCTOR call; it is a step only when it does something.
                if c["method"] == "CONSTRUCTOR" and is_empty(eff):
                    continue
                steps.append({"class": c["class"], "method": c["method"], "calledFrom": c["obj"], "effects": eff})
        return steps

    tcodes_of: dict = {}
    for t in facts["tcodes"]:
        # Without the TSTC lookup a T-code named like its report is still linked to it.
        prog = t["program"] or (t["name"] if t["name"] in programs else None)
        if prog:
            tcodes_of.setdefault(prog, []).append(t["name"])

    chains = []
    for p in (x for x in programs.values() if x["typeId"] == "PROG/P"):
        fam = family(p["name"])
        own = empty_effects()
        for (obj, unit), eff in idx.items():
            if obj in fam and (obj, unit) not in fm_units:
                merge(own, eff)
        chains.append({"kind": "report", "name": p["name"], "description": p["description"] or "",
                       "tcodes": tcodes_of.get(p["name"], []), "own": own,
                       "steps": steps_of([(o, None) for o in fam])})
    for f in facts["functionModules"]:
        group = facts["objects"].get(f["group"]) or {}
        if GENERATED_FUGR.search(group.get("description") or ""):
            continue
        chains.append({"kind": "function", "name": f["name"], "description": group.get("description") or "",
                       "tcodes": [], "own": merge(empty_effects(), idx.get((f["group"], f["name"])) or empty_effects()),
                       "steps": steps_of([(f["group"], f["name"])])})
    return chains


def total_effects(chains) -> dict:
    """Everything all entry points do, together."""
    agg = empty_effects()
    for ch in chains:
        merge(agg, ch["own"])
        for s in ch["steps"]:
            merge(agg, s["effects"])
    return agg
