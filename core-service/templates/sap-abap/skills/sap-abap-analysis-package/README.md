# sap-abap-analysis-package (Agent Skill)

Turns one SAP ABAP package into a technical HTML document. It is a **procedure**, not a
command reference: resolve the SAP system, get the package onto disk, build an LLM context
bundle from it, check the bundle is actually complete, then write the document.

Everything runs through the `adt` and `sapgit` tools. Nothing runs through bash.

## How the agent uses it

1. **Resolve the system** (steps 1-2). No system named → `adt auth profile list` and take
   `defaultProfile`. A system named → `adt auth profile use <name>` if it is not already the
   default.
2. **Check the mirror** (step 3) by reading `.adt/tree.json` — not by globbing for a folder,
   because the mirror is lazy and placeholder folders exist before anything is fetched.
3. **Clone the package, then every sub-package** (steps 4-5). `sapgit clone` goes one level
   deep, so sub-packages need their own clone, repeated until none is left `loaded: false`.
4. **Build the bundle** (steps 6-7). `adt context build` with all nine arguments, into
   `artifacts/<SAP system>/.scratchpad/`.
5. **Verify the bundle** (step 8), because the build can be cut short and still report success.
6. **Read the bundle** (step 9) — `CONTEXT.md`, then every `manifest.json`, then the skeleton
   files for every package.
7. **Read the source of every class it will name** (step 10). The skeleton is predictably thin
   for RAP behaviour pools and generated gateway classes.
8. **Write the document** (step 11) into `artifacts/<SAP system>/.artifacts/`, reproducing all
   22 headings of the TDD chapter tree in `template/`, with mermaid diagrams.

## Directory map

```text
sap-abap-analysis-package/
├── SKILL.md          # The procedure: what to run at each step, gotchas, troubleshooting
├── README.md         # This file
├── references/       # How to run it — read on demand, never all at once
│   ├── adt.md        #   every adt call: argv, flag table, bundle layout, traps
│   ├── sapgit.md     #   every sapgit call: parameters, clone mechanics, folder layout
│   └── document.md   #   reading the bundle cheaply + the full output contract
├── template/         # The Bosch TDD template, exported from Docupedia
│   ├── Technical_Document.html   # mandatory chapter tree + the <style> block to reuse
│   ├── Technical_Document.md     # same content as markdown
│   └── manifest.json             # docu-cli export manifest — NOT part of the output
└── example/          # Worked example of a finished document (empty for now)
```

**`SKILL.md` carries the literal commands; `references/` carries the reasoning.** That split
is deliberate and was learned the hard way: an earlier version kept only prose in `SKILL.md`
("run `adt context build` for the package") and pushed every argument into `references/adt.md`.
The model read `SKILL.md`, never followed the markdown link, improvised the command from the
prose, and shipped a bundle with two of nine arguments. Skills are surfaced to the agent as
name + description + path to `SKILL.md`; reading anything deeper is voluntary, so **anything
the agent must execute exactly belongs in `SKILL.md` itself.** References explain flags, traps
and contracts — they never hold a command you cannot find in `SKILL.md`.

## The output contract

`template/` is the Bosch **TDD** (Technical Development Documentation) template. Three rules
follow from it, all spelled out in `references/document.md`:

- **The chapter tree is mandatory** — every heading, in order, even where there is nothing to
  say.
- **Clean semantic HTML**, reusing the template's `<style>` block. The template still carries
  Confluence wrappers (`contentLayout2`, `confluenceTable`, `aui-lozenge`) because it was
  exported from Docupedia; those are not part of the contract and must not be reproduced.
- **Gaps are stated, never guessed.** OSS, Business Roles, Technical Debt, Release Notes,
  owners and links cannot come from static analysis, so those sections keep their heading and
  say "Not derivable from static code analysis — to be completed by the package owner."

`example/` is still empty. Nothing depends on it; it is there for a worked reference once one
exists.

## Constraints worth knowing when editing this skill

- **The `adt` tool has a 120-second cap, and a signal-killed run reports exit `0`.** A
  `context build` that runs long comes back looking successful with a partial bundle on disk.
  Step 6b is the only thing standing between that and a confidently wrong document — do not
  weaken it. Raising the cap would need a change in `core-service/src/http.ts` (`runAdtCli`),
  deliberately out of scope here.
- **`--out` must be absolute.** The tool's working directory *is* the connection folder when
  a profile resolves and the workspace root when none does, so a relative path means two
  different places depending on invisible state.
- **Do not add `--config` to `context build`.** It is the abaplint rules file, and the
  connection already carries the right one at `.adt/abaplint.json`, which adt-cli discovers
  on its own because the working directory is the connection folder. Passing `--config`
  overrides that layer; pointing it at `pull-config.json` does not even fail — it silently
  yields a config with no lint rules and the wrong ABAP release, degrading the skeleton in
  `structure.json`.
- **`sapgit clone` is one level deep.** `planChildren` in `core-service/src/sapTree.ts` records
  each sub-package as `loaded: false` and does not recurse, so a package whose content sits in
  sub-packages mirrors as a couple of placeholder folders. Step 5 loops until no
  `loaded: false` remains; a run that skips it produces a mirror with almost nothing in it and
  a document to match. This was the largest single cause of a bad first run.
- **The mirror is lazy, so folder existence proves nothing.** Any "is it cloned?" check must
  read `.adt/tree.json`.
- **`sapgit clone` needs `artifacts/<connection>/` to already exist**; only the user, adding
  the connection in the UI, can create it.
- **`context build --out` must not include the package name** — the tool appends `/<PACKAGE>`.
  Passing it produces `.scratchpad/<PKG>/<PKG>/` and breaks every downstream path.
- **A thin `structure.json` is usually correct, not broken.** RAP behaviour pools report
  `methodCount: 0` (handlers live in local classes) and generated gateway classes report
  `no class definition parsed` (they inherit from SAP standard classes absent from the bundle).
  The remedy is reading the source, not changing flags.
- **`.scratchpad/` and `.artifacts/` are in the connection's `.gitignore`** alongside `.adt/`,
  so neither the bundle nor the document is version-controlled — by design. Both are still
  visible in the Artifacts panel: `HIDDEN_ARTIFACT_DIRS` in `core-service/src/http.ts` hides
  only `.git/`.
- **Mermaid loads from a CDN, and direct egress to it is blocked** on the corporate network —
  only the proxy reaches it. That is why the diagram source stays inside
  `<pre class="mermaid">`: mermaid overwrites that element's content when it initialises, so a
  blocked CDN leaves readable source rather than an empty box. The artifact preview iframe
  runs with `allow-scripts` and no CSP, so the script itself is not the obstacle.

## Source of truth

This folder under `core-service/templates/` is the original. The copies under
`core-service/deploy/templates/` and `workspace/templates/` are generated — do not edit those.

Existing workspaces do **not** pick up a new skill automatically: template content is copied
only when a workspace is created. To try it in a workspace that already exists, copy this
folder into that workspace's `skills/`.

The upstream command documentation, if you need to extend `references/`, is
`adt-cli/docs/CLI_REFERENCE.md` §6.12 (`adt context`) and §`adt auth profile`.
