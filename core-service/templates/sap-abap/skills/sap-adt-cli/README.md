# sap-adt-cli (Agent Skill)

Lets the agent operate **`adt-cli`** — the CLI for SAP ABAP Development Tools — against the SAP system
the user connected in this workspace: reading and writing ABAP source, creating and activating
objects, pushing code back with a transport request, running ATC checks and offline abaplint,
mirroring packages, previewing SQL/DDIC data, and reading traces.

## How the agent uses it

1. Commands go through the **`adt` tool**, never through bash. `argv` is the command split into
   arguments with no leading `adt`.
2. Connecting a system and choosing a profile are the **user's** job, done in the UI. The agent never
   touches `auth`, never passes `-p/--profile`, and never asks which system to use.
3. Code is read from the lazy ADT mirror at `artifacts/<SAP system>/` and written to
   `artifacts/<SAP system>/artifacts/`.
4. Every write to SAP outside `$TMP` carries the transport request of the package that owns the
   object.

## Directory map

```text
sap-adt-cli/
├── SKILL.md                 # Router: how to call, identity, folders, routing table, mandatory rules
├── README.md                # This file
└── references/              # Loaded on demand
    ├── workflows.md         # Read / generate / edit / push code, and how to get the transport
    ├── objects.md           # adt object: create, read, edit, lifecycle, list, pull
    ├── quality.md           # adt atc, adt lint, adt context
    ├── data-system.md       # adt data, system, service, cts, trace, debug, http
    └── troubleshooting.md   # flags, exit codes, error→fix, conventions
```

The agent reads `SKILL.md` first, then opens only the reference it needs. For anything involving code,
that is `workflows.md`.

## Constraints worth knowing when editing this skill

- The `adt` tool rejects `--user-jwt`, `--iss`, `--service-binding`, and absolute URLs. `--output` is
  deliberately allowed (since 2026-08-21) so source can go straight to disk without passing through
  the model's context — keeping those writes inside the workspace is the skill's job, not the guard's.
- The tool's working directory is not the connection folder, so every path in `argv` is absolute.
- The mirror is lazy: files start empty and are hydrated on first read. "Empty" means "not fetched",
  never "the object is empty".
- There is no `adt` command that finds an object's transport request; `workflows.md` §E carries the
  one sanctioned raw ADT call for it.

## Source of truth

This folder under `core-service/templates/` is the original. The copies under
`core-service/deploy/templates/` and `workspace/templates/` are generated — do not edit those.

The `references/` files are the complete inventory of what the agent may run — there is no companion
document next to this folder (the old `../CLI_REFERENCE.md` link pointed at a file that was never
shipped here). The upstream sources, if you need to extend the skill, are `adt-cli/README.md` and
`adt-cli/docs/CLI_REFERENCE.md` in the repository.
