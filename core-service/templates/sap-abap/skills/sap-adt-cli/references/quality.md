# Reference: code quality — `adt atc`, `adt lint`, `adt context`

ATC (server-side checks), abaplint (offline static analysis), and LLM context bundles. Examples use
`ZADT_LOCAL` as the package and are written as the `argv` array you pass to the `adt` tool.

Any path you pass (`--config`, `--out`, a file to lint) must be **absolute**.

---

## `adt atc` — ABAP Test Cockpit

Server-side code checks. **Exit `1` when the findings include errors or warnings**, so a non-zero exit
here means "there is something to fix", not "the command broke".

```jsonc
// One-shot: activate variant + run + fetch worklist
["atc", "check", "programs/programs/zhello", "--variant", "DEFAULT", "--max", "50"]

// Step by step, when you want to see each round trip
["atc", "activate", "DEFAULT"]                       // → worklistId
["atc", "run", "<worklistId>", "programs/programs/zhello", "--max", "50"]   // → runId
["atc", "worklist", "<runId>", "--include-exempted"]

// Inspect the environment
["atc", "customizing"]     // available check variants / config
["atc", "users"]           // system users, to map findings to owners
```

| Command | Purpose | Key options |
|---|---|---|
| `activate <variant>` | Activate a check variant, returns `worklistId` | — |
| `run <worklistId> <objectUrl...>` | Run the worklist on object(s), prints `runId` | `--max <n>` (default 100) |
| `worklist <runId>` | Fetch findings; **exit 1 on error/warning** | `--include-exempted`, `--object-set <name>`, `--timestamp <epoch>` |
| `check <objectUrl...>` | End-to-end activate + run + worklist | `--variant <id>` (default DEFAULT), `--max <n>`, `--include-exempted` |
| `customizing` | ATC customizing | — |
| `users` | System users | — |

Common variants: `DEFAULT`, `STANDARD`, `ABAPLINT_DEFAULT`, `S4_CLOUD_PLATFORM_CHECKS`. If you do not
know which one the system uses, read `atc customizing` rather than guessing.

Run an ATC check after pushing refactored code — it is the cheapest evidence that a CleanABAP change
did not break a rule the system actually enforces.

---

## `adt lint` — offline static analysis (abaplint)

Runs `@abaplint/core` locally. Supported types: `CLAS/OC`, `INTF/OI`, `PROG/P`, `PROG/I`.
**Exit codes: `0` clean, `1` errors, `2` warnings only.**

```jsonc
// One object, fetched through ADT then linted offline
["lint", "object", "oo/classes/zcl_foo"]

// A local file — no SAP call at all. Ideal for code you just generated.
["lint", "file", "/abs/path/artifacts/zcl_foo.clas.abap", "--type", "class"]

// A whole package as one Registry, which enables cross-object analysis
["lint", "package", "ZADT_LOCAL", "--max", "200"]
```

| Command | Purpose | Key options |
|---|---|---|
| `object <objectUrl>` | Lint one object from ADT | `--include <name>`, `--config <path>` |
| `file <filePath>` | Lint a local `.abap` file offline | `--type class\|interface\|program\|include`, `--config` |
| `package <package>` | Lint a whole package as one Registry | `--max <n>` (200), `--skip-unsupported`, `--fix` |
| `skeleton --object\|--package` | JSON skeleton (classes/methods/interfaces); 5–10× cheaper than raw ABAP as context | `--config`, `--max` |
| `metrics --object\|--package` | Cyclomatic complexity + method length; flags god classes (>30 methods) | `--top <n>` (0 = all), `--config`, `--max` |
| `refs --object <url> --line <n> --char <n>` | Find references at a position (LSP) | `--package` (cross-object), `--config`, `--max` |
| `format --object\|--package` | PrettyPrinter → JSON result; **does not push to SAP** | `--config`, `--max` |

```jsonc
["lint", "package", "ZADT_LOCAL", "--fix"]
["lint", "skeleton", "--package", "ZADT_LOCAL"]
["lint", "metrics", "--package", "ZADT_LOCAL", "--top", "10"]
["lint", "refs", "--object", "oo/classes/zcl_foo", "--line", "42", "--char", "12",
 "--package", "ZADT_LOCAL"]
```

Notes:

- `--fix` and `format` **return** the changed sources; neither writes to SAP and neither writes a
  file. Save the result yourself, then push it with workflow D.
- `--line` / `--char` for `refs` are **1-based** and both required. Add `--package` for cross-object
  resolution.
- `lint file` is the fastest check on generated code: it needs no system and no transport.

---

## `adt context` — LLM-ready context bundles

Walk a package and emit a multi-file bundle (skeleton + metadata + reading guide), sized for a model.
Prefer this over reading dozens of raw sources when you need to understand a package as a whole.

```jsonc
["context", "build", "--package", "ZADT_LOCAL", "--out", "/abs/path/adt-context",
 "--with-docs", "--with-where-used"]
["context", "inspect", "/abs/path/adt-context/ZADT_LOCAL", "--target-model", "claude-opus-4-7"]
["context", "budget"]
```

| Command | Purpose | Notable options |
|---|---|---|
| `build` | Emit a context bundle per package | `--depth` (0 = root, omit = unlimited), `--include-source [glob]`, `--strip light\|medium\|aggressive`, `--with-docs`, `--with-where-used`, `--max` (500), `--namespace-prefixes`, `--clean` / `--no-overwrite`, `--keep-going`, `--dry-run`; exit `1` if any package errored |
| `inspect <bundleDir>` | Recompute token estimates against the target model's soft cap | `--target-model` (default `claude-opus-4-7`), `--max-tokens`; exit `2` if over budget |
| `budget` | Print the model context-window / soft-cap table | `--target-model` (highlights one) |

`--out` writes into your output folder — pass an absolute path under
`artifacts/<SAP system>/artifacts/`, never anywhere else.
