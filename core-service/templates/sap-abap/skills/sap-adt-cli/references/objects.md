# Reference: `adt object` — repository objects

Create, read, edit, manage the lifecycle of, and mirror ABAP repository objects. For the end-to-end
read / generate / edit / push sequences, start from [workflows.md](workflows.md); this file is the
command detail those workflows refer to.

Every example is the `argv` array you pass to the `adt` tool.

> **Object URL forms** — `<objectUrl>` accepts a relative path (`programs/programs/zhello`,
> `oo/classes/zcl_demo`) or an absolute one (`/sap/bc/adt/programs/programs/zhello`). Full URLs are
> rejected by the tool.

---

## Create objects

```jsonc
["object", "create", "<kind>", "<NAME>", ...options]
```

**Common options (every kind):**

| Flag | Effect |
|---|---|
| `--description <text>` | Short text (`adtcore:description`) |
| `--responsible <user>` | `adtcore:responsible` (default: profile user) |
| `--transport <id>` | Transport request (`corrNr`) — see workflows.md §E |
| `--validate-only` | Validate the name, then stop |
| `--no-validate` | Skip validation |
| `--source-file <file>` | After create: lock + PUT source from file (**absolute path**) |
| `--source-stdin` | Not usable through the tool — stdin is closed. Use `--source-file` |
| `--activate` | After create (+ optional source push): activate |

**Object kinds (`<kind>` → typeId, parent flag):**

| Kind | typeId | Parent flag | Max len |
|---|---|---|---|
| `program` | PROG/P | `--package` | 30 |
| `class` | CLAS/OC | `--package` | 30 |
| `interface` | INTF/OI | `--package` | 30 |
| `include` | PROG/I | `--package` | 30 |
| `fgroup` | FUGR/F | `--package` | 26 |
| `fmodule` | FUGR/FF | `--group <fgroup>` | — |
| `finclude` | FUGR/I | `--group <fgroup>` | — |
| `ddl` | DDLS/DF | `--package` | 30 |
| `dcl` | DCLS/DL | `--package` | 30 |
| `ddlx` | DDLX/EX | `--package` | 30 |
| `ddla` | DDLA/ADF | `--package` | 30 |
| `package` | DEVC/K | `--super-package` | 30 |
| `table` | TABL/DT | `--package` | 16 |
| `service-def` | SRVD/SRV | `--package` | 30 |
| `service-binding` | SRVB/SVB | `--package` + `--service` | 30 |
| `dtel` | DTEL/DE | `--package` | 30 |
| `msag` | MSAG/N | `--package` | 20 |
| `auth-field` | AUTH | `--package` | 10 |
| `auth-object` | SUSO/B | `--package` | 10 |

`["object", "create-types"]` lists all aliases live, with typeId, parent flag, max length, and
creation path.

**Kind-specific options:**

- `package` (DEVC/K): `--super-package <pkg>`, `--swcomp <comp>`, `--transport-layer <layer>`,
  `--package-type development|structure|main` (default `development`)
- `fmodule`, `finclude`: `--group <fgroup>` (required)
- `service-binding` (SRVB/SVB): `--service <name>` (required), `--binding-type <type>` (default
  `ODATA`), `--category 0|1` (0 = Web API, 1 = UI; default 0)

**Examples:**

```jsonc
// Program: validate → create → source → activate in one command
["object", "create", "program", "ZHELLO", "--package", "ZADT_LOCAL",
 "--description", "Hello", "--source-file", "/abs/path/zhello.prog.abap", "--activate"]

// Class
["object", "create", "class", "ZCL_DEMO", "--package", "ZADT_LOCAL",
 "--description", "Demo class", "--source-file", "/abs/path/zcl_demo.clas.abap", "--activate"]

// Function group, then a function module inside it
["object", "create", "fgroup", "ZGRP_DEMO", "--package", "ZADT_LOCAL", "--description", "Demo FG"]
["object", "create", "fmodule", "Z_FM_DEMO", "--group", "ZGRP_DEMO", "--description", "Demo FM"]

// CDS data definition
["object", "create", "ddl", "ZI_DEMO", "--package", "ZADT_LOCAL",
 "--source-file", "/abs/path/zi_demo.ddls.asddls", "--activate"]

// Service definition + binding
["object", "create", "service-def", "ZSRVD_DEMO", "--package", "ZADT_LOCAL",
 "--source-file", "/abs/path/zsrvd_demo.srvd.srvdsrv", "--activate"]
["object", "create", "service-binding", "ZSB_DEMO", "--package", "ZADT_LOCAL",
 "--service", "ZSRVD_DEMO", "--binding-type", "ODATA", "--category", "0"]

// Validate a name without creating anything
["object", "validate", "class", "ZCL_FOO", "--package", "ZADT_LOCAL"]
```

`["object", "create-generic", "--type", "PROG/P", "--name", "ZHELLO", "--package", "ZADT_LOCAL", ...]`
creates by explicit typeId when no alias fits; it takes the same parent/source/activate options.

---

## Read objects

```jsonc
["object", "structure", "oo/classes/zcl_demo"]                       // metadata + include list
["object", "structure", "oo/classes/zcl_demo", "--version", "inactive"]
["object", "properties", "/sap/bc/adt/programs/programs/zhello/source/main"]
["object", "source", "programs/programs/zhello"]                     // source → result
["object", "source", "oo/classes/zcl_demo", "--include", "definitions"]
["object", "versions", "programs/programs/zhello"]                   // revision history
```

| Command | Purpose | Key options |
|---|---|---|
| `structure <objectUrl>` | Object metadata; also the existence check in workflows.md §D | `--version active\|inactive\|workingArea` |
| `properties <uri>` | Property values for a source URI | — |
| `source <objectUrl>` | Read source text | `--include <name>` (default `main`), `--version`, `--output <abs path>` |
| `versions <objectUrl>` | Version history | `--include <name>` |

`--output <absolute path>` writes the result to a file instead of returning it. Use it whenever you
do not need to read the content — see workflows.md §A.

```jsonc
["-q", "object", "source", "programs/programs/zhello", "--output", "/abs/path/zhello.prog.abap"]
```

---

## Edit source

Read → edit → push → activate, as laid out in workflows.md §C and §D.

```jsonc
["object", "set-source", "programs/programs/zhello",
 "--file", "/abs/path/zhello.prog.abap", "--transport", "<TR>"]
["object", "activate", "programs/programs/zhello"]
```

`set-source` does lock + PUT + unlock in one stateful session.

| Flag | Effect |
|---|---|
| `--file <file>` | Source file — **absolute path** |
| `--include <name>` | Include name (default `main`) |
| `--transport <id>` | Transport request |
| `--keep-locked` | Hold the lock after the PUT |
| `--lock-handle <handle>` | Reuse an existing lock |

Manual `lock` / `unlock` exist but are rarely useful: every command runs as a fresh process with a
fresh cookie jar, so a lock taken in one call is gone by the next.

---

## Lifecycle: activate / inactive / delete

```jsonc
["object", "activate", "programs/programs/zhello"]      // exit 1 when success=false
["object", "activate", "programs/programs/zhello", "--no-preaudit"]
["object", "inactive"]                                  // objects awaiting activation
["object", "delete", "programs/programs/zhello", "--transport", "<TR>"]
```

- `activate` returns `{ success, messages, inactive }`; exit `1` means `success=false` and `messages`
  says why.
- **`delete` is destructive → STOP AND ASK a human first** (SKILL.md rule 2).

---

## List tree nodes

```jsonc
["object", "list", "--parent-type", "DEVC/K", "--parent-name", "ZADT_LOCAL", "--json"]
["object", "list", "--package", "$TMP", "--user", "<user>", "--json"]
```

Returns `{ nodes, categories, objectTypes }` — the direct children of one tree node. This is the same
call the Artifacts panel uses to materialize the mirror, so you rarely need it: prefer reading the
mirror. Reach for it when you need to see objects in a package the user has not added.

---

## `adt object pull` — mirror a package to local disk

Offline-first: pull a package once, then analyse it many times (input for `lint package` and
`context build`). Files are written in abapGit naming.

```jsonc
["object", "pull", "--package", "ZADT_LOCAL", "--out", "/abs/path/target-dir"]
["object", "pull", "--package", "ZADT_LOCAL", "--print-config"]   // resolved config, no SAP call
```

`--out` is **not** the blocked `--output` flag and is allowed — but it must be an absolute path, and
it must point inside your output folder.

| Flag | Effect |
|---|---|
| `--package <pkg>` (required) | Package to mirror |
| `--out <dir>` | Output dir (default `./<package-lowercase>` — always pass it explicitly) |
| `--depth <n>` | Recurse sub-packages: `0` = root only, omit = unlimited |
| `--max <n>` | Max objects (default 500) |
| `--include-only <ids>` | CSV typeIds — full override of the pull config |
| `--skip-types <ids>` | CSV typeIds to subtract |
| `--no-dependencies` | Skip the where-used graph |
| `--keep-going` | Continue on per-object failure (default true) |
| `--skip-unsupported` | Suppress warnings for unknown typeIds |
| `--namespace-prefixes <csv>` | Name prefixes to keep, e.g. `Z,Y,/RB`. Empty `""` = pull nothing |
| `--print-config` | Print the effective config as JSON and exit |

**Output** in `--out`: the source files, plus `.abap-package.json` (manifest v3 — an `inventory[]`
entry for every walked node with `status` `pulled` / `not-in-config` / `not-in-namespace` /
`unknown-type` / `fetch-failed`) and `.dependencies.json` (inbound where-used edges).
