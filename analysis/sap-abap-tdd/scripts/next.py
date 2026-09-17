#!/usr/bin/env python3
"""The pipeline driver. Run it, do exactly what it prints, run it again — until it
prints DONE or STOP.

  python next.py --system D8R --package /RB4R/MM_PUR_DAT_COCKPIT [--new] [--workspace <abs>]

The driver never talks to SAP. It reads the run's state from disk, decides the one
next step, and prints it as a literal tool call for the agent (an `adt` call or the
one `sapgit clone`). Everything else — preparing folders, extracting facts,
rendering tables and diagrams, assembling and validating the HTML — it performs
itself, in-process, and moves on. The document is complete without the model
writing anything; `--with-prose` adds one writing task, a narrative chapter 1.

Why a driver: the agent reliably reads SKILL.md and nothing else, and a weak
model skips, reorders or invents steps described in prose. A state machine that
hands out one concrete instruction at a time leaves nothing to skip.
"""

from __future__ import annotations

import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib import (  # noqa: E402
    PULL_TYPE_GROUPS, PULL_TYPES, RunPaths, fwd, namespace_of, new_run_id, parse_args,
    read_json, read_text, resolve_workspace, safe_folder, to_json, utf8_stdout, write_json, write_text,
)
from facts import build_facts, read_preview  # noqa: E402
from packets import plan_tasks  # noqa: E402
from compose import compose  # noqa: E402

utf8_stdout()

SELF = Path(__file__).resolve()
MAX_PULL_ATTEMPTS = 3
MAX_TASK_ATTEMPTS = 2
MAX_LIST_ATTEMPTS = 2
# Data-preview lookups (TSTC, transports) get a second go. The attempt is counted when
# the action is printed, and adt writes no --output file on an HTTP error, so a call
# the model skipped looks exactly like one SAP refused — gpt-5-nano skipped the E07T
# lookup live on 2026-09-14 and the run lost its transport descriptions.
MAX_LOOKUP_ATTEMPTS = 2
MAX_PACKAGES = 80
MAX_DEPTH = 8
CODE_TYPES = {"CLAS/OC", "INTF/OI", "PROG/P", "PROG/I", "FUGR/F", "FUGR/FF", "FUGR/I", "DDLS/DF", "DDLS/DL"}

args = parse_args(sys.argv[1:])
system = str(args["system"]).upper() if args.get("system") not in (None, True) else ""
pkg = str(args["package"]).upper() if args.get("package") not in (None, True) else ""
with_prose = args.get("with-prose") is True


def emit(lines) -> None:
    sys.stdout.write("\n".join(l for l in lines if l is not None) + "\n")
    sys.stdout.flush()


def stop(reason: str):
    emit(["STOP", reason, "Report this to the user verbatim and ask how to proceed. Do not work around it."])
    sys.exit(0)


def interpreter() -> str:
    """How the agent should call Python again: the same command name that found us
    on PATH (python / python3), or the absolute interpreter path as a last resort."""
    stem = Path(sys.executable).stem
    if shutil.which(stem):
        return stem
    return f'"{fwd(sys.executable)}"'


if not system or not pkg:
    emit(["STOP", "Usage: python next.py --system <SAP_SYSTEM> --package <PACKAGE> [--new]"])
    sys.exit(0)

workspace = resolve_workspace(system, args.get("workspace") if isinstance(args.get("workspace"), str) else None)
if not workspace:
    stop(f"The connection folder artifacts/{system}/ does not exist. The user has to add the {system} connection in the Octo UI first.")

# ---------------------------------------------------------------------------
# Run selection. A run is one snapshot of SAP; `--new` starts a fresh one and
# removes the older runs of this package (only the newest is kept).
# ---------------------------------------------------------------------------
pkg_root = RunPaths(workspace, system, pkg, "_").pkgRoot
latest_file = pkg_root / "latest.txt"
run_id = latest_file.read_text(encoding="utf-8").strip() if not args.get("new") and latest_file.exists() else ""
if not run_id:
    run_id = new_run_id()
    pkg_root.mkdir(parents=True, exist_ok=True)
    for entry in os.scandir(pkg_root):
        if entry.is_dir() and entry.name != run_id:
            shutil.rmtree(entry.path, ignore_errors=True)
    write_text(latest_file, run_id)
P = RunPaths(workspace, system, pkg, run_id)
P.runDir.mkdir(parents=True, exist_ok=True)

state = read_json(P.state, None) or {
    "system": system,
    "package": pkg,
    "runId": run_id,
    "createdAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    "cloneIssued": False,
    "packages": {pkg: {"parent": None, "depth": 0}},
    "namespaces": [],
    "attempts": {},
    "degradations": [],
}


def save() -> None:
    write_json(P.state, state)


ws_arg = f' --workspace "{fwd(Path(args["workspace"]).resolve())}"' if isinstance(args.get("workspace"), str) else ""
rerun = f'{interpreter()} "{fwd(SELF)}" --system {system} --package "{pkg}"{ws_arg}{" --with-prose" if with_prose else ""}'


def bump(key: str) -> int:
    state["attempts"][key] = state["attempts"].get(key, 0) + 1
    save()
    return state["attempts"][key]


def degrade(message: str) -> None:
    if message not in state["degradations"]:
        state["degradations"].append(message)
    save()


def step(title: str) -> str:
    return f"STEP · {title}   (run {run_id})"


def adt_action(title: str, argv: list, label: str):
    emit([
        step(title),
        "ACTION: call the `adt` tool with exactly these arguments (copy them verbatim, change nothing):",
        to_json({"argv": argv, "label": label}, indent=None),
        "Whatever it returns — success, an error, or no output — do not interpret or retry it yourself.",
        f"THEN: run the driver again with bash: {rerun}",
    ])
    sys.exit(0)


# ---------------------------------------------------------------------------
# Step 0 — make sure the user can see the package in the workspace. This clone
# is for the user only; nothing below reads from it.
# ---------------------------------------------------------------------------
tree = read_json(P.connDir / ".adt" / "tree.json", {"entries": {}})
cloned = any(
    isinstance(e, dict) and e.get("kind") == "package" and e.get("loaded") is True and str(e.get("adtParentName") or "").upper() == pkg
    for e in (tree.get("entries") or {}).values()
)
if not cloned and not state["cloneIssued"]:
    state["cloneIssued"] = True
    save()
    emit([
        step(f"show {pkg} in the workspace"),
        "ACTION: call the `sapgit` tool with exactly these arguments:",
        to_json({"command": "clone", "connectionName": system, "packageName": pkg}, indent=None),
        "This is the only sapgit call of the whole analysis. If it fails, continue anyway — the analysis does not depend on it.",
        f"THEN: run the driver again with bash: {rerun}",
    ])
    sys.exit(0)

# ---------------------------------------------------------------------------
# Step 1a — discover the package tree, one `object list` (nodestructure) per package.
#
# `object pull --depth 0` cannot do this. Its manifest's `subPackages` lists the
# packages the pull *walked* besides the root (adt-cli pull.js), and with depth 0
# only the root is walked, so the list is always empty. That is how the first live
# run on /RB4R/MM_PUR_DAT_COCKPIT analysed only the root — two package interfaces,
# no code — and still reported DONE. The listing names the direct DEVC/K children;
# the driver recurses through them itself, breadth first.
# ---------------------------------------------------------------------------
while True:
    pending = next((n for n, r in state["packages"].items() if not r.get("listed")), None)
    if pending is None:
        break
    rec = state["packages"][pending]
    file = P.discover / f"{safe_folder(pending)}.json"
    listing = read_json(file, None)
    if isinstance(listing, dict) and isinstance(listing.get("nodes"), list):
        for node in listing["nodes"]:
            if not isinstance(node, dict) or node.get("typeId") != "DEVC/K":
                continue
            child = str(node.get("name") or "").upper().strip()
            # Already known covers both a repeated listing and a cycle.
            if not child or child in state["packages"]:
                continue
            if rec["depth"] + 1 > MAX_DEPTH or len(state["packages"]) >= MAX_PACKAGES:
                degrade(f"The package tree was cut at {MAX_PACKAGES} packages / depth {MAX_DEPTH}; deeper packages are not analysed.")
                continue
            state["packages"][child] = {"parent": pending, "depth": rec["depth"] + 1, "description": node.get("description") or None}
        rec["listed"] = "ok"
        save()
        continue
    # Missing, or not a listing (an error text, a truncated write): ask again.
    if file.exists():
        file.unlink()
    key = f"list:{pending}"
    if state["attempts"].get(key, 0) >= MAX_LIST_ATTEMPTS:
        rec["listed"] = "failed"
        degrade(f"{pending}: its sub-packages could not be listed, so any sub-packages below it are missing from the document.")
        continue
    P.discover.mkdir(parents=True, exist_ok=True)
    bump(key)
    adt_action(f"find the sub-packages of {pending}", [
        "-q", "--output", fwd(file),
        "object", "list", "--package", pending, "--json",
    ], f"Sub-packages of {pending}")

# ---------------------------------------------------------------------------
# Step 1 — snapshot every package into .scratchpad, one `object pull` per package.
#
# Two facts about adt-cli shape this step (both verified on D8R):
#   * It names namespaced files `/rb4r/foo.clas.abap` and writes them relative to
#     --out without creating the `rb4r/` folder, so every /RB4R/ object fails with
#     ENOENT unless the folder exists beforehand. The driver creates it.
#   * A command killed at the 120 s cap still reports exit 0, so success is judged
#     by `.abap-package.json` on disk, never by the exit code.
# ---------------------------------------------------------------------------


def prepare_out_dir(d: Path, name: str) -> None:
    d.mkdir(parents=True, exist_ok=True)
    spaces = list(state["namespaces"])
    own = namespace_of(name)
    if own and own not in spaces:
        spaces.append(own)
    for ns in spaces:
        (d / ns).mkdir(parents=True, exist_ok=True)


def missing_namespaces(manifest: dict) -> list:
    """Namespaces whose objects failed only because their folder was missing."""
    out = []
    for item in manifest.get("inventory") or []:
        if item.get("status") == "fetch-failed" and "ENOENT" in (item.get("reason") or ""):
            ns = namespace_of(item.get("name"))
            if ns and ns not in out:
                out.append(ns)
    return out


def pull_argv(name: str, d: Path, types: list) -> list:
    # --out right after the command, not last: in live run 5 the model dropped the tail
    # of this argv, and without --out adt-cli pulls into path.resolve("/rb4r/<pkg>") —
    # the drive root — instead of the snapshot.
    return [
        "-q", "object", "pull",
        "--out", fwd(d),
        "--package", name,
        "--depth", "0",
        "--keep-going",
        "--no-dependencies",
        "--include-only", ",".join(types),
    ]


def ensure_pulled(name: str, d: Path, types: list, key: str, title: str) -> dict:
    """Check one pull target. Returns {done, manifest}, or issues the pull (and exits)."""
    manifest_file = d / ".abap-package.json"
    if manifest_file.exists():
        manifest = read_json(manifest_file, {})
        missing = missing_namespaces(manifest)
        if not missing:
            return {"done": True, "manifest": manifest}
        for ns in missing:
            if ns not in state["namespaces"]:
                state["namespaces"].append(ns)
        save()
        if state["attempts"].get(key, 0) >= MAX_PULL_ATTEMPTS:
            degrade(f"{name}: {len(missing)} namespace(s) still failing after {MAX_PULL_ATTEMPTS} pulls ({', '.join(missing)}).")
            return {"done": True, "manifest": manifest}
        manifest_file.unlink()
    if state["attempts"].get(key, 0) >= MAX_PULL_ATTEMPTS:
        return {"done": False, "exhausted": True}
    prepare_out_dir(d, name)
    bump(key)
    adt_action(title, pull_argv(name, d, types), f"Snapshot {name}")


while True:
    pending = next((n for n, r in state["packages"].items() if not r.get("pulled")), None)
    if pending is None:
        break
    rec = state["packages"][pending]
    base = P.src / safe_folder(pending)
    manifests = []

    if not rec.get("groupMode"):
        r = ensure_pulled(pending, base, PULL_TYPES, f"pull:{pending}", f"snapshot {pending}")
        if r["done"]:
            manifests = [r["manifest"]]
        else:
            # The whole-package pull never produced its manifest: most likely the 120 s
            # cap. Retry in smaller type groups, each into its own folder.
            rec["groupMode"] = True
            degrade(f"{pending}: whole-package pull did not finish; pulled by type group instead.")
    if rec.get("groupMode"):
        for i, group in enumerate(PULL_TYPE_GROUPS):
            d = Path(f"{base}@g{i + 1}")
            r = ensure_pulled(pending, d, group, f"pull:{pending}:g{i + 1}", f"snapshot {pending} (part {i + 1}/{len(PULL_TYPE_GROUPS)})")
            if r["done"]:
                manifests.append(r["manifest"])
            else:
                degrade(f"{pending}: type group {','.join(group)} could not be pulled — those objects are missing from the document.")

    rec["pulled"] = True
    rec["objectCount"] = sum(m.get("objectCount") or 0 for m in manifests)
    rec["hasCode"] = any(i.get("status") == "pulled" and i.get("typeId") in CODE_TYPES for m in manifests for i in (m.get("inventory") or []))
    # The manifest's `subPackages` is deliberately ignored — see step 1a.
    save()

# ---------------------------------------------------------------------------
# Sanity check. A tree without a single code object would still assemble into a
# template of empty tables and "Not derivable" — a document that looks finished
# and says nothing. Stop and say so instead.
# ---------------------------------------------------------------------------
all_pkgs = list(state["packages"].items())
if not any(r.get("hasCode") for _, r in all_pkgs):
    failed_lists = [n for n, r in all_pkgs if r.get("listed") == "failed"]
    stop("\n".join(x for x in [
        f"No ABAP code was found in {pkg} on {system}.",
        f"Packages checked: {len(all_pkgs)}" + (f" ({pkg} and its sub-packages)" if len(all_pkgs) > 1 else "") + ":",
        *(f"   - {n}: {r.get('objectCount') or 0} object(s) pulled, none of them classes, interfaces, programs, function groups or CDS views" for n, r in all_pkgs[:30]),
        f"   - … and {len(all_pkgs) - 30} more" if len(all_pkgs) > 30 else None,
        f"The sub-packages of {', '.join(failed_lists)} could not be listed, so code below them may have been missed." if failed_lists else None,
        "A technical document built from this would be empty. Check the package name, or whether the code lives in another package.",
    ] if x))

# ---------------------------------------------------------------------------
# Step 1b — which program each transaction code starts. The TRAN object itself
# only carries metadata, so read TSTC (repository metadata, not business data).
# One attempt; if data preview is not allowed on the system, carry on without it.
# ---------------------------------------------------------------------------
tcodes = []
if P.src.exists():
    for entry in os.scandir(P.src):
        m = read_json(Path(entry.path) / ".abap-package.json", None)
        for i in (m or {}).get("inventory") or []:
            if i.get("typeId") == "TRAN/T":
                t = str(i.get("name")).upper().strip()
                if t not in tcodes:
                    tcodes.append(t)
tstc_file = P.meta / "tstc.xml"
if tcodes and not tstc_file.exists():
    if state["attempts"].get("tstc", 0) < MAX_LOOKUP_ATTEMPTS:
        P.meta.mkdir(parents=True, exist_ok=True)
        bump("tstc")
        lst = ", ".join(f"'{t}'" for t in tcodes[:80])
        adt_action("look up the programs behind the transaction codes", [
            "-q", "--raw", "--output", fwd(tstc_file),
            "data", "sql", f"SELECT tcode, pgmna, dypno FROM tstc WHERE tcode IN ( {lst} )",
            "--rows", "200",
        ], "Programs behind transaction codes")
    degrade("Transaction code → program lookup (TSTC) was not possible; entry points are listed without their programs.")

# ---------------------------------------------------------------------------
# Step 1c — transport history for the release notes: the requests that carry the
# package object itself (R3TR DEVC <package>), not every object inside it — that is
# what the release notes are meant to list. Three single-table lookups: E071 names
# the task the package sits on, E070 the request behind that task (STRKORR) with its
# date and owner, E07T the short texts. Each query needs the previous one's result,
# so the driver reads the file before building the next argv.
#
# One query with joins was tried live on D8R (2026-09-13) and refused by the data
# preview: "Only one SELECT statement is allowed." for the two-join shape and
# `"TABLE" is invalid here (due to grammar).` for the single join. The endpoint takes
# one table — which is why the TSTC lookup above works.
#
# A single-table E071 query naming all 20 objects (~700 characters) was refused live
# on D8R (2026-09-14) with the same "Only one SELECT statement is allowed.", while the
# 80-character TSTC query passes. So every statement is kept short: one key filter,
# and IN lists cut to MAX_SQL_CHARS. The suspected cause — the endpoint splitting the
# text into 255-character source lines — is not verified; short statements avoid it
# either way.
#
# Only E071 is required; if a later lookup fails the release notes still name the
# requests, and if E071 itself fails they fall back to the objects' change dates.
# ---------------------------------------------------------------------------
MAX_SQL_CHARS = 240
TRANSPORT_DEGRADED = "The transport history of the package (E070 / E071) could not be read; the release notes list the objects' last change dates instead."


def quoted(values) -> str:
    return ", ".join(f"'{v}'" for v in values)


def in_list_sql(prefix: str, values: list) -> tuple:
    """`<prefix> ( 'a', 'b', ... )` with as many values as fit in MAX_SQL_CHARS,
    and how many of them made it."""
    used = values[:1]
    for v in values[1:]:
        if len(f"{prefix} ( {quoted(used + [v])} )") > MAX_SQL_CHARS:
            break
        used.append(v)
    return f"{prefix} ( {quoted(used)} )", len(used)


def distinct(values) -> list:
    out = []
    for v in values or []:
        v = str(v).strip().upper()
        if v and v not in out:
            out.append(v)
    return out


def transport_lookup(file, key: str, title: str, sql: str) -> bool:
    """Issue one lookup (the driver exits there), or return False once its attempts
    are spent. A file left from a failed attempt holds an error text."""
    if state["attempts"].get(key, 0) >= MAX_LOOKUP_ATTEMPTS:
        return False
    if file.exists():
        file.unlink()
    P.meta.mkdir(parents=True, exist_ok=True)
    bump(key)
    adt_action(title, ["-q", "--raw", "--output", fwd(file), "data", "sql", sql, "--rows", "1000"], title)
    return True


# Released (TRSTATUS R) workbench (K) or customizing (W) requests whose E071 lists
# R3TR DEVC <package>. Releasing a task copies its object entries onto the request,
# so filtering E070 on the request types needs no task → request (STRKORR) step.
# First as one join; ORDER BY is left to facts.py to keep the statement short. If
# the data preview refuses the join, the same answer in two single-table lookups.
RELEASED_REQUEST = "trfunction IN ( 'K', 'W' ) AND trstatus = 'R'"
tr_files = {t: P.meta / f"transports-{t}.xml" for t in ("join", "e071", "e070", "e07t")}
requests = None
join = read_preview(tr_files["join"])
if join is not None:
    requests = distinct(join.get("TRKORR"))
elif not transport_lookup(
        tr_files["join"], "transports:join", "look up the released transport requests of the package",
        f"SELECT r~trkorr, r~as4date, r~as4user FROM e071 AS o INNER JOIN e070 AS r ON r~trkorr = o~trkorr "
        f"WHERE o~object = 'DEVC' AND o~obj_name = '{pkg}' AND r~{RELEASED_REQUEST.replace(' AND ', ' AND r~')}"):
    e071 = read_preview(tr_files["e071"])
    if e071 is None:
        if not transport_lookup(tr_files["e071"], "transports:e071", "look up the transports of the package",
                                f"SELECT trkorr FROM e071 WHERE pgmid = 'R3TR' AND object = 'DEVC' AND obj_name = '{pkg}'"):
            degrade(TRANSPORT_DEGRADED)
    else:
        # Newest first, so a cut IN list keeps the recent requests.
        ids = sorted(distinct(e071.get("TRKORR")), reverse=True)
        e070 = read_preview(tr_files["e070"])
        if ids and e070 is None:
            sql, n = in_list_sql(f"SELECT trkorr, as4date, as4user FROM e070 WHERE {RELEASED_REQUEST} AND trkorr IN", ids)
            if n < len(ids):
                degrade(f"The transport history covers the newest {n} of {len(ids)} transport entries of the package.")
            if not transport_lookup(tr_files["e070"], "transports:e070", "look up the released transport requests", sql):
                degrade(TRANSPORT_DEGRADED)
        elif ids:
            requests = distinct(e070.get("TRKORR"))

if requests and read_preview(tr_files["e07t"]) is None:
    sql, _ = in_list_sql("SELECT trkorr, langu, as4text FROM e07t WHERE trkorr IN", sorted(requests, reverse=True))
    if not transport_lookup(tr_files["e07t"], "transports:e07t", "look up the transport descriptions", sql):
        degrade("The descriptions of the transport requests (E07T) could not be read.")

# ---------------------------------------------------------------------------
# Step 2 — optional enrichment: abaplint skeleton + metrics from `context build`.
# No where-used and no long texts: on D8R the first is noise and the second is
# empty, and both push a package past the 120 s cap. If the bundle is not
# produced, the facts fall back to scanning the snapshot.
# ---------------------------------------------------------------------------
for name, rec in state["packages"].items():
    if not rec.get("hasCode") or rec.get("bundle"):
        continue
    d = P.bundle / safe_folder(name)
    if (d / "manifest.json").exists():
        rec["bundle"] = "ok"
        save()
        continue
    key = f"bundle:{name}"
    if state["attempts"].get(key, 0) >= 1:
        rec["bundle"] = "skipped"
        degrade(f"{name}: context bundle not produced (probably the 120 s cap); complexity metrics come from source scanning.")
        continue
    P.bundle.mkdir(parents=True, exist_ok=True)
    bump(key)
    adt_action(f"analyse {name}", [
        "-q", "context", "build",
        "--package", name,
        "--depth", "0",
        "--out", fwd(P.bundle),
        "--target-model", "gpt-5-nano",
        "--keep-going",
    ], f"Analyse {name}")

# ---------------------------------------------------------------------------
# Step 3 — facts, deterministic. Rebuilt whenever it is missing.
# ---------------------------------------------------------------------------
facts = read_json(P.facts, None)
if not facts:
    facts = build_facts(P, state)
    write_json(P.facts, facts)

# ---------------------------------------------------------------------------
# Step 4 — assemble into the template and validate. Every chapter is generated from
# the facts, so this alone yields the complete document (the Functional Description
# keeps the template's guidance). Prose from the optional intro task is added to
# chapter 1 when it passes the checks; a fragment that fails is left out of the
# document and set aside, so its task is handed out again below.
#
# Composing before any writing task is what makes a weak model safe here: in live
# run B, gpt-5-nano abandoned the loop at the writing tasks every time, and the
# document used to be assembled only after them.
# ---------------------------------------------------------------------------
result = compose(P, facts, state)
if result.get("skeletonError"):
    stop(f"Internal error: the assembled document differs from the template outside the slots ({to_json(result['skeletonError'], indent=None)}). The skill needs fixing.")
for r in result["rejected"]:
    os.replace(r["file"], f"{r['file']}.rejected")

# ---------------------------------------------------------------------------
# Step 5 — only with --with-prose: one writing task, from facts only.
# ---------------------------------------------------------------------------
if with_prose:
    for task in plan_tasks(P, facts, state):
        missing = [t for t in task["targets"] if not t.exists()]
        if not missing:
            continue
        key = f"task:{task['id']}"
        if state["attempts"].get(key, 0) >= MAX_TASK_ATTEMPTS:
            degrade(f'Writing task "{task["title"]}" was not completed; chapter 1 carries the generated summary only.')
            continue
        bump(key)
        emit([
            step(task["title"]),
            *([f"{len(result['rejected'])} earlier file(s) broke a rule and were set aside:",
               *(f"   * {Path(r['file']).name}: {r['reason']}" for r in result["rejected"])] if result["rejected"] else []),
            "ACTION: a writing task.",
            f"1. Read this file completely with your read tool: {fwd(task['packet'])}",
            "   It contains the facts, the rules and what to write. Do not read any other file.",
            "2. Write these files with your write tool (HTML fragments, no <html>/<head>/<body>, no <h1>/<h2>):",
            *(f"   - {fwd(t)}" for t in missing),
            "Use only names and facts from the packet. If something is not in it, do not write it.",
            f"THEN: run the driver again with bash: {rerun}",
            # Live run 4: gpt-5-nano wrote the note, attached it and ended its turn — the
            # analysis stopped at the first writing task.
            "Writing the files does not finish the analysis. Do not reply to the user and do not attach anything: your next tool call is the bash command above.",
        ])
        sys.exit(0)

state["completedAt"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
save()
with_code = sum(1 for r in state["packages"].values() if r.get("hasCode"))
emit([
    "DONE",
    f"Technical document: {fwd(P.output)}",
    f"Packages analysed: {len(state['packages'])} ({with_code} with code); objects in snapshot: {facts['totals']['objects']}; chapters filled: {result['filled']}/{result['slotCount']} (Functional Description is kept as in the template).",
    "Limitations to tell the user:" if state["degradations"] else "No limitations.",
    *(f"   - {d}" for d in state["degradations"]),
    "Tell the user where the document is and list the limitations above. Do not claim more than this.",
])
