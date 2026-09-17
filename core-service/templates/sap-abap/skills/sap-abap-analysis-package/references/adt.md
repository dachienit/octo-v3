# `adt` tool reference

Drives **`adt-cli`** (the CLI for SAP ABAP Development Tools) against the ABAP system the user
connected in this workspace.

Call the **`adt` tool**. Never run `adt` through bash — that path carries no user identity and will
fail.

- `argv`: the command split into arguments, **without the leading `adt`**.
- `label`: a short phrase describing why, shown to the user.

Exit codes: `0` ok, `1` the command failed or reported findings, `2` auth or network.

---

## Resolve the SAP system

```json
{
  "argv": ["auth", "profile", "list"],
  "label": "ADT: list auth profiles"
}
```

Returns JSON:

```json
{
  "defaultProfile": "T4X",
  "profiles": [{ "name": "T4X", "kind": "destination", "url": "...", "user": "..." }]
}
```

`defaultProfile` is the SAP system a bare command runs against. On a user who has configured
nothing the answer is `{ "defaultProfile": null, "profiles": [] }` — **still exit `0`**, so
read the values, never the exit code.

## Set the system as default

```json
{
  "argv": ["auth", "profile", "use", "<SAP_SYSTEM>"],
  "label": "ADT: use profile <SAP_SYSTEM>"
}
```

`<SAP_SYSTEM>` must be one of the `name` values from `profile list`. An unknown name fails
with `ERR  Profile "<name>" does not exist.` and exit `1` — it does not create anything.

Every later command resolves against this default, so it has to succeed first.

## Build the context bundle

```json
{
  "argv": [
    "context",
    "build",
    "--package", "<PACKAGE_NAME>",
    "--depth", "5",
    "--out", "<ABSOLUTE_PATH>/artifacts/<SAP_SYSTEM>/.scratchpad",
    "--target-model", "gpt-5-nano",
    "--strip=aggressive",
    "--with-docs",
    "--with-where-used",
    "--keep-going"
  ],
  "label": "ADT: build context bundle for <PACKAGE_NAME>"
}
```

### What the bundle looks like

Written per package, one folder each — with `--depth 5`, every sub-package gets its own
sibling folder under `--out`:

```text
<out>/<PACKAGE>/
├── manifest.json       # package metadata + object inventory; has objectCount, subPackages, generatedAt
├── structure.json      # rich skeleton: classes, interfaces, programs, function groups
├── dependencies.json   # cross-object dependency graph (outbound edges)
├── metrics.json        # per-class cyclomatic complexity + method length
├── CONTEXT.md          # reading guide
├── ddic.json           # only when the package holds DDIC objects
└── docs/               # only with --with-docs
```

### All `context build` flags

| Flag | Meaning |
|---|---|
| `--package <pkg>` (required) | Root ABAP package |
| `--out <dir>` (required) | Output sap system directory (default `./scratchpad`) |
| `--depth <n>` (required) | Recurse into sub-packages N levels deep (`0` = root only, omitted = unlimited) |
| `--target-model <id>` (required) | Record the target LLM in the manifest, for token budgeting |
| `--max-tokens <n>` | Soft token cap; content is degraded if exceeded |
| `--include-source [glob]` | Include raw ABAP source for objects matching the glob |
| `--strip [level]` | Strip boilerplate from sources: `light\|medium\|aggressive` (no value = `medium`) |
| `--with-docs` (required) | Fetch object and package long texts |
| `--with-where-used` (required) | Fetch inbound references via `/usageReferences` |
| `--types <list>` | CSV of typeId families (`CLAS,INTF,PROG,FUGR,DDIC,CDS`) — **not wired yet, only warns** |
| `--max <n>` | Max objects per package (default `500`) |
| `--namespace-prefixes <csv>` | CSV of object-name prefixes to keep, overriding pull-config; e.g. `Z,Y,/RB` |
| `--clean` | Delete `<out>/<PACKAGE>/` before writing (not with `--no-overwrite`) |
| `--no-overwrite` | Abort if `<out>/<PACKAGE>/` already exists |
| `--keep-going` (required) | Continue when one object fails (default: stop at the first error) |
| `--dry-run` | Walk and classify only — **no** fetching or writing; prints intended actions |

`--strip=aggressive` (required) as one argument and `--strip`, `aggressive` as two parse identically;
either is fine.

---

## Read one object's source

The bundle's skeleton is enough for most of the document. When you genuinely need the body
of a single object — the algorithm inside a method, the exact SELECT, how an enhancement
hooks in — read that one object and no more:

```json
{
  "argv": ["-q", "object", "source", "<SOURCE_URL>"],
  "label": "Read source of <OBJECT_NAME>"
}
```

`<SOURCE_URL>` comes from the bundle: `manifest.json` → `objects[]` → the `uri` field of the
object you want. Do not construct it by hand.

Options: `--include <name>` (default `main`) for a specific include, and
`--version active|inactive|workingArea`.

### Reach for this sparingly

Sources are large and they land in your context whole. The bundle already gives you class
and method signatures, dependency edges, and complexity metrics — read a body only when the
document needs something those cannot answer, and name the reason to yourself first.

If you do not need to read the content yourself, have the CLI write it to disk instead:

```json
{
  "argv": ["-q", "object", "source", "<SOURCE_URL>", "--output", "<ABSOLUTE_PATH>"],
  "label": "Save source of <OBJECT_NAME>"
}
```

The path must be **absolute**, and write only inside `artifacts/<SAP_SYSTEM>/.scratchpad/` or
`.artifacts/`. Never overwrite a file in the mirrored package tree — that is what the SAP
system currently looks like.

