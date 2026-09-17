# Reading the bundle & writing the document

## Part 1 — Read the bundle cheaply

The bundle is on disk, not in your context. Pull in what you need, in this order, and stop
as soon as you can answer the section you are writing.

### 1. Start with `CONTEXT.md`

Every package folder has one, and it is the reading guide — read it **first and in full**.
It gives you, without opening anything else:

- an identity table: package, parent, software component, application component, transport
  layer, package type, master language, responsible, changed by/at;
- the sub-package list;
- the inventory: total object count and a count per type;
- the files in that bundle, each with a **token estimate** — use these to decide what you
  can afford to open;
- a dependency summary: node count, edge count, edge kinds.

### 2. Then `manifest.json`

The object inventory. Each entry in `objects[]` carries `typeId`, `type`, `name`, `uri`,
`description`, `package`, `responsible`, `createdBy/At`, `changedBy/At`, `masterLanguage`,
`abapLanguageVersion`, `version`.

This is where object-level facts for the document come from — and where `uri` comes from
when you need [adt.md § Read one object's source](adt.md).

### 3. Read the skeleton files — they are small

`structure.json` holds the skeleton (`classes`, `interfaces`, `programs`, `functionGroups`,
plus a count of each); `dependencies.json` holds outbound dependency edges;
`metrics.json` holds per-class cyclomatic complexity and method length; `ddic.json` holds
tables, data elements and domains.

`CONTEXT.md` prints the token cost of each. In practice a package bundle is a few hundred
tokens in total, so **read these files** — do not skip them to save context you are not
short of. Reach for **grep** only when `CONTEXT.md` shows a file is genuinely large.

Read them for **every** package, the root included. The root of a package tree often holds
almost nothing while a sub-package holds everything; a document written from the busiest
sub-package alone is still incomplete.

### 3b. Expect the skeleton to be thin, and know why

The skeleton comes from parsing sources with abaplint, without SAP's standard library. Three
consequences show up on nearly every real package, and none of them means "there is nothing
there":

| What you see | Why | What to do |
|---|---|---|
| `methodCount: 0` on a RAP behaviour pool (`ZBP_*`) | Handler methods live in local classes (`lhc_*`) the skeleton does not reach | Read the source |
| `"error": "no class definition parsed"` on `*_DPC`, `*_DPC_EXT`, `*_MPC` | Generated gateway classes inherit from SAP standard classes absent from the bundle | Read the source |
| A class with interfaces but no methods of its own | Its methods come from the interface | Read the interface, or the source |

Never write "this class has no methods" from a `methodCount` of 0. Read the source instead —
see [adt.md § Read one object's source](adt.md).

### 4. Walk every package, not just the root

With `--depth 5` each sub-package has its own sibling folder under `.scratchpad/`. Glob
`.scratchpad/*/CONTEXT.md` to enumerate them. A document that covers only the root package
is incomplete — and `manifest.json`'s `subPackages` is what tells you how many there should
be.

### 5. Only then read source

The skeleton answers *what exists and how it connects*. Read an actual body only for
something the skeleton cannot answer — see [adt.md § Reach for this sparingly](adt.md).

---

## Part 2 — Write the document

### Where it goes

```text
artifacts/<SAP_SYSTEM>/.artifacts/<PACKAGE>_Technical_Document.html
```

Create `.artifacts/` if missing. It is in the connection's `.gitignore`, so the document
stays out of version control — but it **is** listed and packaged by the Artifacts panel, so
the user can open and download it. (Only `.git/` is hidden from that panel.)

Never write into the mirrored package tree.

### The output contract

[../template/Technical_Document.html](../template/Technical_Document.html) and
[../template/Technical_Document.md](../template/Technical_Document.md) are the Bosch **TDD**
(Technical Development Documentation) template, exported from Docupedia.

- **The chapter tree is mandatory.** Keep every heading, in order, at the same level:

  ```text
  H1 Motivation and Key Figures
     H2 Short description and summary of functions
     H2 Business problems solved, benefits
  H1 Functional Description
  H1 Technical Description (High-Level Architecture)
     H2 Frontend components
     H2 Package structure and dependencies
     H2 APIs and other external interfaces
     H2 Most important classes
     H2 Data model
     H2 Used SAP enhancements
     H2 Business Roles & Authorizations
     H2 Output Management
     H2 Open Source Software (OSS)
     H2 Technical Debt Tracking
  H1 Deployment
     H2 Technical Prerequisites & Dependencies
     H2 Transport Considerations
     H2 Local Adaptation
     H2 Local Role maintenance
     H2 Deletion and Phase-out
  H1 Release Notes
  ```

- **Keep the governance scaffolding** from the top of the template — Page Release Status, the
  owner/reviewer table, Page Revision History, Release Notes — as empty tables for a human to
  fill. Do not invent owners, dates, links, or versions.
- **Reuse the template's `<style>` block** verbatim. It already handles light and dark and
  gives tables, `pre`, and blockquotes sane defaults.
- **Write clean semantic HTML** — `<h2>`, `<table>`, `<pre>`. Do **not** reproduce the
  template's Confluence wrappers (`contentLayout2`, `confluenceTable`, `aui-lozenge`, the
  `confluence-userlink` anchors); those are artefacts of the Docupedia export, not part of
  the contract.
- `template/manifest.json` is docu-cli's export manifest. It describes how the template was
  obtained and is **not** part of the output — do not reproduce it.

### Sections the code cannot answer

Static analysis cannot tell you about Open Source Software, Business Roles &
Authorizations, Technical Debt ratings, SolDoc/Jira links, package owners, or Release Notes.

**Keep the section and say so plainly:**

```html
<p><em>Not derivable from static code analysis — to be completed by the package owner.</em></p>
```

Never guess, and never present an inference as a verified fact. A TDD that quietly contains
guesswork is worse than one with honest gaps.

Where you *did* infer something from code, say what it was inferred from — e.g. "authorization
objects referenced by `AUTHORITY-CHECK` in `ZCL_FOO`" is a finding; "the roles required to run
this package" is not.

### Diagrams

Diagram what the bundle actually shows. At minimum:

| Diagram | Section | Built from |
|---|---|---|
| Package & sub-package tree | Package structure and dependencies | `manifest.json` → `subPackages`, recursively |
| Component / dependency graph | Package structure and dependencies | `dependencies.json` edges |
| Class relationships of the main classes | Most important classes | `structure.json` → `classes`, `interfaces` |
| Data model | Data model | `ddic.json`, plus CDS entries in `manifest.json` |
| Process / call flow per function | Functional Description | `dependencies.json` call edges, plus source read on demand |

Emit each as a mermaid block:

```html
<pre class="mermaid">
graph TD
  A[ZCL_ORDER_FACADE] --> B[ZCL_ORDER_VALIDATOR]
  A --> C[ZIF_ORDER_SINK]
</pre>
```

and load mermaid once, near the end of `<body>`:

```html
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>mermaid.initialize({ startOnLoad: true });</script>
```

**Why this shape degrades safely:** mermaid replaces the content of each `pre.mermaid` when
it initialises. If the CDN is unreachable — direct egress to it is blocked on the corporate
network and only the proxy reaches it, so this does happen — nothing runs, and the reader
sees the mermaid source as plain text instead of a blank box. Keep the source inside
`pre.mermaid` for exactly that reason; do not move it into a JS string.

Pin the major version as shown. Do not add any other external script, stylesheet, font, or
image — everything else must be inline.

### Before you hand it over

- Every mandated heading is present, in order.
- Every claim traces to a bundle file or a source you actually read.
- Every gap is marked with the "not derivable" line rather than left blank or guessed.
- Every mermaid block is syntactically valid on its own.
- No external reference except the one mermaid script.
