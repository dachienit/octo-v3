---
name: sap-abap-analysis-package
description: >
  Use this skill to analyse a whole SAP ABAP package and turn it into a technical
  document in HTML. Trigger on requests to analyse, document, review, or "understand" an
  ABAP package, or to produce package documentation. It resolves the SAP system, clones the
  package and all its sub-packages into `artifacts/`, builds an LLM context bundle, reads
  the sources that matter, and writes a TDD-format HTML document. Always works through the
  `adt` and `sapgit` tools, never through bash. On any failure it stops and asks the user
  instead of continuing.
license: PROPRIETARY
metadata:
  version: "0.3.0"
---

# sap-abap-analysis-package

Analyses one ABAP package end to end. Every command you need is written out below — run them
as given.

**Always** drive SAP through the **`adt`** and **`sapgit`** tools. Never through bash — not
even for `mkdir`; use your file tools.

## Two rules that outrank every step below

1. **If any step fails, STOP.** Report the error verbatim and ask the user what to do. Do not
   guess a different package name, do not fall back to another system, do not skip ahead, do
   not retry with different flags on your own. A half-finished analysis that looks finished is
   worse than no analysis.
2. **Do not drop flags from the commands below.** They are not decoration — `--with-docs` and
   `--with-where-used` are the difference between a document and a table of object counts. Run
   each command exactly as written, substituting only the `<PLACEHOLDERS>`.

## Before step 9 you MUST have read

- `template/Technical_Document.md` — the mandatory chapter tree. You cannot write the
  document without it; there are **22 headings** and you must reproduce every one.
- [references/document.md](references/document.md) — the output contract and the mermaid recipe.

Read them when you reach step 7, not at the end.

| Reference | For |
|---|---|
| [references/adt.md](references/adt.md) | `adt` flag tables, bundle layout, the traps |
| [references/sapgit.md](references/sapgit.md) | `sapgit` parameters and `clone` mechanics |
| [references/document.md](references/document.md) | Reading the bundle cheaply + the full output contract |
| [template/](template/) | The mandatory TDD chapter tree and the `<style>` block to reuse |

---

## Step 1 — Resolve the SAP system

**The user named a system** → go to step 2. **Otherwise** run:

```json
{ "argv": ["-q", "auth", "profile", "list"], "label": "List SAP systems" }
```

Take `defaultProfile` from the JSON as the system and go to **step 3**.

`defaultProfile` is `null`/`""`/absent, or `profiles` is empty → **STOP.** Ask the user to
connect a system in the UI.

## Step 2 — Set that system as default

Run `auth profile list` first if you have not. Then:

- Already equals `defaultProfile` → go to step 3.
- Not in `profiles` → **STOP**, list the real names, ask which they meant.
- Otherwise:

```json
{ "argv": ["-q", "auth", "profile", "use", "<SAP_SYSTEM>"], "label": "Select SAP system" }
```

## Step 3 — Is the package really cloned?

A folder existing is **not** proof it was cloned — the tree is materialised lazily, so
placeholder folders and empty files are normal. Check the manifest, not the folder:

1. **read** `artifacts/<SAP_SYSTEM>/.adt/tree.json`.
2. It is fully cloned only if **both** hold:
   - an entry for `<PACKAGE_FOLDER>` with `kind: "package"` and `loaded: true`, **and**
   - **no** entry anywhere with `kind: "package"` and `loaded: false`.
3. Anything else → go to **step 4**.

`<PACKAGE_FOLDER>` is the package name with `/` replaced by `#` (`/RB/FOO` → `#RB#FOO`).

`artifacts/<SAP_SYSTEM>/` or its `.adt/tree.json` missing → **STOP.** Only the user, adding
the connection in the UI, can create the connection folder.

## Step 4 — Clone the package

```json
{ "command": "clone", "connectionName": "<SAP_SYSTEM>", "packageName": "<PACKAGE_NAME>" }
```

Clone failed → **STOP and ask.** Do not fall back to reading objects one by one.

## Step 5 — Clone every sub-package (do NOT skip this)

**`sapgit clone` goes one level deep.** It lists the named package's direct children and
records each sub-package as `loaded: false` — it does **not** recurse. A package whose real
content sits in sub-packages will otherwise give you a mirror with almost nothing in it, and
a document to match. This is the single most common way this analysis comes out worthless.

So, repeatedly:

1. **read** `artifacts/<SAP_SYSTEM>/.adt/tree.json`.
2. Collect every entry with `kind: "package"` and `loaded: false`; take its `adtParentName`.
3. Call `sapgit clone` (same shape as step 4) for **each** of those names.
4. Go back to 1. Sub-packages can nest, and each clone reveals the next level.

Stop when no `loaded: false` package entry remains. Cloned sub-packages land as **siblings**
at the connection root (`artifacts/<SAP_SYSTEM>/<SUBPACKAGE>/`), not nested inside the parent.

## Step 6 — Create the scratchpad

Create `artifacts/<SAP_SYSTEM>/.scratchpad/` with your **write** tool if it is not there.
Note its **absolute** path. Do not use bash.

## Step 7 — Build the context bundle

```json
{
  "argv": [
    "-q", "context", "build",
    "--package", "<PACKAGE_NAME>",
    "--depth", "5",
    "--out", "<ABSOLUTE_PATH_TO>/artifacts/<SAP_SYSTEM>/.scratchpad",
    "--target-model", "gpt-5-nano",
    "--strip=aggressive",
    "--with-docs",
    "--with-where-used",
    "--keep-going"
  ],
  "label": "Build context bundle for <PACKAGE_NAME>"
}
```

Two ways this goes wrong, both seen in practice:

- **`--out` ends at `.scratchpad`.** The tool appends `/<PACKAGE>` itself. Adding the package
  name yourself produces `.scratchpad/<PACKAGE>/<PACKAGE>/` and every path below breaks.
- **All nine arguments are required.** Dropping `--with-docs` and `--with-where-used` costs
  you the long texts and the inbound references — the material for half the document.

## Step 8 — Verify the bundle (mandatory)

**Do not trust step 7's exit code.** A build killed at the 120-second limit still reports
exit `0` with a partial bundle. Only the files on disk tell the truth.

1. **glob** `artifacts/<SAP_SYSTEM>/.scratchpad/<PACKAGE>/manifest.json`. Missing → **STOP and ask.**
2. **read** it. Note `objectCount` and `subPackages`.
3. For every name in `subPackages`, check `.scratchpad/<SUBPACKAGE>/manifest.json` exists.
   Any missing → the build was cut short → **STOP**, name what is missing, and ask.
4. Check a `CONTEXT.md` sits next to each `manifest.json`.

Incomplete → **offer** these and let the user choose, do not pick one yourself: a smaller
`--depth`; dropping `--with-docs`/`--with-where-used`; or one sub-package at a time.

## Step 9 — Read the bundle

Read it all, cheapest first:

1. **glob** `artifacts/<SAP_SYSTEM>/.scratchpad/*/CONTEXT.md` to enumerate every package.
2. **read** each `CONTEXT.md` in full — the reading guide, with a token estimate per file.
3. **read** every `manifest.json` — including the **root** package's, not just the busiest one.
4. **read** `structure.json`, `dependencies.json` and `metrics.json` for each package
   (`CONTEXT.md` gives their token cost; these bundles are usually a few hundred tokens, so
   read them rather than guessing). **grep** instead only when a file is genuinely large.
5. **read** `ddic.json` and `docs/` where they exist.

`manifest.json` → `subPackages` says how many packages there should be. A document covering
only one of them is incomplete.

→ [references/document.md § Read the bundle cheaply](references/document.md)

## Step 10 — Read the sources that matter

`structure.json` is thinner than it looks, and predictably so:

- A RAP **behaviour pool** (`ZBP_*`) shows `methodCount: 0` because its handlers live in local
  classes the skeleton does not reach.
- Gateway/OData generated classes (`*_DPC`, `*_DPC_EXT`, `*_MPC`) come back as
  `"error": "no class definition parsed"` — they inherit from SAP standard classes that are not
  in the bundle.
- A class that gets its methods from an interface shows no methods of its own.

So for **every class you intend to name in the document**, read its source:

```json
{ "argv": ["-q", "object", "source", "<SOURCE_URL>"], "label": "Read source of <OBJECT_NAME>" }
```

`<SOURCE_URL>` is the `uri` field of that object in `manifest.json` → `objects[]`. Never build
it by hand.

This step is **not** optional garnish. "Most important classes", "Data model", "APIs and other
external interfaces" and the process flows cannot be written from counts alone. Read what you
are about to describe.

→ [references/adt.md § Read one object's source](references/adt.md)

## Step 11 — Write the technical document (HTML)

Write to `artifacts/<SAP_SYSTEM>/.artifacts/<PACKAGE>_Technical_Document.html`.

Before writing, **read `template/Technical_Document.md`** and copy its heading structure.

- **All 22 headings, in order, at the template's levels.** Do not invent your own outline, do
  not renumber, do not merge or drop sections. A section with nothing to say still gets its
  heading.
- **Reuse the template's `<style>` block** verbatim; do not write your own CSS.
- Write clean semantic HTML — `<h2>`, `<table>`, `<pre>`. Do **not** reproduce the template's
  Confluence wrappers (`contentLayout2`, `confluenceTable`, `aui-lozenge`).
- **Mermaid diagrams are required**, at minimum: package/sub-package tree, dependency graph,
  class relationships, data model, and one process flow per function. Each as
  `<pre class="mermaid">`, with the mermaid script once near the end of `<body>`.
- Sections static analysis cannot answer (OSS, Business Roles, Technical Debt, Release Notes,
  owners, links) keep their heading and get exactly:
  *"Not derivable from static code analysis — to be completed by the package owner."*
  **Never guess, never present an inference as a verified fact.**

→ [references/document.md § Write the document](references/document.md)

### Self-check before you hand it over

Do not report success until all of these are true:

- [ ] Every sub-package was cloned (`tree.json` has no `loaded: false` package).
- [ ] `context build` ran with all nine arguments.
- [ ] A `manifest.json` exists for the root package and every sub-package.
- [ ] You read `structure.json` and `dependencies.json` for every package.
- [ ] You read the source of every class you named.
- [ ] The document has all 22 template headings, in order.
- [ ] The document contains at least three mermaid diagrams and the mermaid script.
- [ ] Every gap says "Not derivable from static code analysis", not a guess.

---

## Gotchas

- **`sapgit clone` is one level deep.** Sub-packages come back `loaded: false` and need their
  own clone. Step 5 exists for this and skipping it is the main cause of a worthless document.
- **A timed-out `adt` command reports success.** The 120-second cap kills the child with a
  signal, and a signal-killed process has no exit code, which is reported as `0`. Hence step 8.
- **`--out` for `context build` must not include the package name** — the tool appends it.
- **Relative paths in `argv` are ambiguous.** The working directory *is* the connection folder
  when a profile resolves and the workspace root when none does, so pass absolute paths.
- **An existing folder does not mean a cloned package.** The mirror is lazy: folders and empty
  files appear before anything is fetched. `tree.json` is the only reliable check.
- **Package folder names are sanitised** (`/` → `#`). Glob for the sanitised name.
- **`.scratchpad/` and `.artifacts/` are gitignored**, so neither the bundle nor the document
  appears in `sapgit status`. Correct, not a bug — and both are still listed and downloadable
  in the Artifacts panel, which hides only `.git/`.
- **The mermaid CDN may not resolve.** Direct egress to it is blocked on the corporate network;
  only the proxy reaches it. Keeping the diagram source inside `<pre class="mermaid">` is what
  makes a blocked CDN degrade to readable text instead of a blank box.
- **Never write into the mirrored package tree.** Your output belongs in `.artifacts/`.

## Troubleshooting

| Symptom | What it means | What to do |
|---|---|---|
| `Connection folder for 'X' not found under artifacts/.` | The connection was never added in the UI | STOP, ask the user to add it |
| `auth profile list` returns `defaultProfile: null` and `profiles: []` | Nothing is configured for this user | STOP, ask the user to connect a system |
| Any `adt` command exits `2` | Auth or network failure | STOP. Do **not** try to log in or repair a profile |
| `ERR  Profile "X" does not exist.` (exit `1`) | `auth profile use` got a name that is not saved | STOP, list the names from `profiles`, ask which they meant |
| Step 7 exits `0` but `manifest.json` is missing | Cut off at the 120-second cap | See the recovery options in step 8 |
| Bundle path is `.scratchpad/<PKG>/<PKG>/` | `--out` included the package name | Re-run step 7 with `--out` ending at `.scratchpad` |
| Mirror has one file but the package has dozens | Step 5 was skipped — content is in sub-packages | Run step 5 until no `loaded: false` remains |
| `structure.json` shows `methodCount: 0` or `no class definition parsed` | Expected for RAP behaviour pools and generated gateway classes | Read the source (step 10); do not report it as "no methods" |
| `structure.json` skeleton is thin across the board | `--config` was passed, overriding the connection's abaplint config | Re-run step 7 without `--config` |
| No `docs/` folder in the bundle | `--with-docs` was dropped | Re-run step 7 with all nine arguments |
