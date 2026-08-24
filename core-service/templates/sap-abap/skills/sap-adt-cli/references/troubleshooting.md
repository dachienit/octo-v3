# Reference: flags, exit codes, conventions, troubleshooting

Cross-cutting reference for every command you run through the `adt` tool.

---

## Global flags

These may appear anywhere in `argv`.

| Flag | Effect |
|---|---|
| `-q, --quiet` | Errors only. Worth using when you want the data and not the progress log |
| `-v, --verbose` | Log HTTP method / URL / status |
| `--debug` | Full headers (auth redacted) + body previews |
| `--raw` | Skip XML→JSON parsing; return the body as-is |
| `--json` | Force JSON output |
| `--output <file>` | Write the result to a file (**absolute path**) instead of returning it |
| `--accept <mime>` | Override the `Accept` header |
| `--insecure` | Skip TLS verification (already set on the connection when needed) |

**Not available to you** — the tool rejects them: `--user-jwt`, `--iss`, `--service-binding`, and any
absolute URL. `-p/--profile` is not rejected but must never be used: the system is chosen by the app,
not by you.

---

## Object-URL forms

`<objectUrl>` accepts:

- relative: `programs/programs/zhello`, `oo/classes/zcl_demo`
- absolute path: `/sap/bc/adt/programs/programs/zhello`

A full URL (`https://…`) is rejected.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Failure (HTTP non-2xx, parse error, `activate` reported `success=false`) **or** ATC/lint found **errors** |
| `2` | Auth / network failure, **or** ATC/lint found **warnings only** |

`1` is ambiguous by design: for `atc check` and `lint *` it means "there are findings", everywhere
else it means "the command failed". Read the output before deciding which.

---

## Errors specific to this setup

| Message | What it means | What to do |
|---|---|---|
| `Argument not allowed: --user-jwt` (or `--iss`, `--service-binding`, an `https://…` argument) | The tool refused the command before it ran | Rebuild it without that argument. For the URL: use a relative object URL — the absolute form would send the user's token to that host |
| A file written with `--output` is not where you expected | The path was relative, and the tool's working directory is not the connection folder | Re-run with an absolute path |
| `No chat turn is in flight…` | The command was attempted outside a user turn (a background or scheduled run) | Not a SAP fault. ADT work only happens inside a conversation |
| `The ADT capability is not wired up in this process.` | Infrastructure problem, not yours | Report it and stop |
| Auth or connection failure on any command | The connection is broken or expired | Report it and stop. Do **not** try to log in or switch systems — the user fixes this in the UI |
| `Profile … not found` / no profile | No system is connected in this workspace | Ask the user to connect one in the UI |

---

## Other symptoms

| Symptom | Fix |
|---|---|
| A file in the mirror is empty | Expected — it has not been hydrated yet. Follow workflows.md §A |
| `object source` returns 404 for a file that exists in the tree | The object has no text source; fetch its XML by URI instead (workflows.md §A step 4) |
| HTTP 403 on a write | CSRF token expired; the CLI retries once by itself. If it persists, re-run with `-v` |
| HTTP 401 during lock / set-source | The stateful session was dropped. Re-run the command — each call starts a fresh session |
| `Validation failed: ERROR Object name not allowed` | The name is outside the customer namespace (`Z`/`Y`) or too long — see the max lengths in objects.md |
| `HTTP 423 Locked` | Someone, or a failed earlier run, holds the lock. Report it; do not force it |
| `object pull` stalls on a function group | The namespace filter let SE54-generated includes through. Check `--print-config` and `--namespace-prefixes` |
| A needed endpoint has no `adt` command | **Escalate to a human.** Do not craft raw `http request` calls beyond the two allowed uses |

---

## Conventions

- The system is chosen by the app; the user manages connections in the UI.
- Read from `artifacts/<SAP system>/`, write to `artifacts/<SAP system>/artifacts/`.
- Paths passed in `argv` are always absolute.
- Writes outside `$TMP` always carry the package's transport request (workflows.md §E).
- All identifiers, comments, and string literals in generated code are in **English**.
- ABAP follows **CleanABAP**; verify with `atc check` or `lint`.
