---
name: sap-adt-cli
description: Use this skill whenever a task touches an SAP ABAP system through ADT — reading or writing ABAP source, creating/activating/deleting objects (programs, classes, interfaces, CDS, function modules, packages, DDIC), pushing code back to SAP with a transport request, running ATC checks or offline abaplint, mirroring packages, previewing SQL/DDIC data, or reading traces. Trigger on any mention of ABAP, ADT, SAP objects, transport requests, ATC, abaplint, or on any request to read, generate, refactor, or push ABAP code. Commands run through the `adt` tool. Connecting a system and choosing a profile are done by the user in the UI and are out of scope.
---

# sap-adt-cli

Drives **`adt-cli`** (the CLI for SAP ABAP Development Tools) against the ABAP system the user
connected in this workspace.

## How to run a command

Call the **`adt` tool**. Never run `adt` through bash — that path carries no user identity and will
fail.

- `argv`: the command split into arguments, **without the leading `adt`**.
  Example: `["object", "source", "programs/programs/zhello"]`
- `label`: a short phrase describing why, shown to the user.

stdout comes back as the result. Exit `1` = the command failed or reported findings, `2` = auth or
network. `-q` as the first argument suppresses progress logs and is worth using when you only want the
data.

## Identity is not your concern

The user connects systems in the UI. The connection they are working in is already the active one, so
**a bare command targets the right system**.

- Never pass `-p` / `--profile`, and never run anything in the `auth` group.
- Never ask the user which profile, system, client, or credentials to use.
- If a command fails with an authentication or connection error, report it and stop. Do not try to
  log in, repair a profile, or pick a different system.

## Rejected arguments

The tool refuses these outright, so never build them: absolute URLs (`http://…`, `https://…`),
`--user-jwt`, `--iss`, `--service-binding`.

An absolute URL is refused because adt-cli would send the user's live token to it. Object URLs are
always relative (`oo/classes/zcl_demo`) or root-relative (`/sap/bc/adt/...`), so this never limits a
legitimate command.

## Let the CLI write the file

`--output <absolute path>` writes a command's result straight to disk. **Prefer it whenever you do
not need to read the content yourself** — pulling a class body through your context to write it back
out unchanged wastes the budget and can hit the 60,000-character result cap.

```jsonc
["-q", "object", "source", "<adtUri>", "--output", "/abs/path/zcl_demo.clas.abap"]
```

Two rules that go with it:

- The path must be **absolute**. The tool's working directory is not the connection folder, so a
  relative path lands somewhere you did not intend.
- Write only inside `artifacts/<SAP system>/` (hydrating a mirror file) or your output folder. The
  tool does not enforce this — you do.

## Where files live

Two folders, and the difference matters:

| Folder | What it is | You may |
|---|---|---|
| `artifacts/<SAP system>/` | Mirror of the ABAP object tree, materialized when the user adds a package. `<SAP system>` is the connection name. | **read only** |
| `artifacts/<SAP system>/artifacts/` | Your output: code you generate or modify. Create it if missing. | read + write |

**Never overwrite a file in the mirror.** It is what the system looks like right now; your edits are
proposals until they are pushed. The one exception is hydrating an empty mirror file with the source
you just read from SAP (workflow A) — that fills in what the mirror already claims to hold.

The working directory of the `adt` tool is **not** the connection folder, so every path you pass in
`argv` (`--output`, `--file`, `--source-file`, `--out`) must be **absolute**. Take it from what your
file tools report; do not assume a relative path resolves anywhere useful.

## Route to the right reference

Read the matching file **on demand** — never all of them at once.

| If the task involves… | Read |
|---|---|
| Reading, generating, editing, or pushing code; getting a transport request | [references/workflows.md](references/workflows.md) — **start here for any code task** |
| Object commands in detail: create kinds and flags, structure/source/versions, lifecycle, `pull` | [references/objects.md](references/objects.md) |
| ATC checks, abaplint, LLM context bundles | [references/quality.md](references/quality.md) |
| SQL/DDIC data, system discovery, service bindings, CTS, traces, debugger, raw HTTP | [references/data-system.md](references/data-system.md) |
| Object-URL forms, exit codes, error→fix table | [references/troubleshooting.md](references/troubleshooting.md) |

These five files are the whole inventory of what you may run. A command or flag that appears in none
of them does not exist for you — never invent one. `["--help"]` and `["<group>", "--help"]` are
always available if you need to confirm a signature against the installed version.

## Mandatory rules

1. **Writes to SAP always carry the transport request of the package that holds the object.**
   Determine it as described in workflows.md §E; skip it only for `$TMP` and other local objects.
   Never guess a transport id, and never create a new transport request.
2. **STOP AND ASK a human before anything destructive**: `adt object delete`, or overwriting SAP
   source you did not read first in this same task.
3. **Never fabricate an ADT endpoint.** `adt http request` is allowed for exactly two things: the
   transport-check recipe in workflows.md §E, and reading an object's raw metadata by the URI the
   tree manifest already gave you. Anything else has no documented `adt` command → escalate to a
   human.
4. **Never print credentials, tokens, or internal paths** into your answer.
5. Generated ABAP follows **CleanABAP**; all identifiers, comments, and string literals are in
   **English**.
