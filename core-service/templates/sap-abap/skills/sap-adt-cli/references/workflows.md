# Reference: the five code workflows

How to read, generate, edit, and push ABAP code, and how to get the transport request that a write
needs. Every `adt` call below is a tool call — `argv` is shown as the array you pass.

Shorthand used here:

- `<conn>` — the connection folder, `artifacts/<SAP system>/` (read-only mirror of the ABAP tree).
- `<out>` — your output folder, `<conn>/artifacts/`. Create it on first use.

`argv` entries are passed to the process directly, never through a shell, so nothing needs quoting or
escaping — a value with spaces, quotes, or `<`/`>` is one array element and arrives intact.

---

## A. Read an object's code

The mirror is **lazy**: adding a package creates the folder and file names, but every file starts
**empty**. An empty file means "not fetched yet", not "the object is empty".

1. Read the file under `<conn>`.
2. **If it has content, use it and stop.** Do not call SAP again for an object you already have.
3. If it is empty, look its path up in `<conn>/.adt-tree.json` → `entries["<path relative to conn>"]
   .adtUri`, then let the CLI fill the file directly:

   ```jsonc
   ["-q", "object", "source", "<adtUri>", "--output", "<absolute path to that empty file>"]
   ```

   Then read the file. The source never passes through your context on the way in, which is the whole
   point of doing it this way — read it only if you actually need to look at it. The file is now
   hydrated and step 2 short-circuits next time.
4. **If step 3 fails with 404**, the object has no text source (DDIC types, views, message classes,
   transactions, authorization objects — the ones whose file name ends in `.xml`). Its content is the
   ADT object XML itself:

   ```jsonc
   ["-q", "--raw", "http", "request", "GET", "<adtUri>", "--output", "<absolute path to the .xml file>"]
   ```

File names follow abapGit: `<name>.<type-slug>.<abap|xml>` — `zcl_foo.clas.abap`, `zif_bar.intf.abap`,
`ztable.tabl.xml`. The slug tells you the object type without another round trip.

If an object you need is not in the mirror at all, the user has not added its package. Ask them to add
it from the Artifacts panel rather than materializing it yourself.

---

## B. Generate new code

Write the new file into `<out>`, using the same abapGit naming so it sits alongside everything else.
Nothing reaches SAP at this stage — creating the object there is workflow D.

---

## C. Modify existing code

1. Run workflow A to get the current source. Never edit an object you have not read: what you assume
   is in the system is not evidence.
2. Apply the change.
3. Write the **complete file after the change** into `<out>` — full contents, not a patch or a
   fragment. Leave the mirror copy untouched, so the difference between "what SAP has" and "what I
   propose" stays visible.

---

## D. Push code to SAP

1. Read the local file the user wants to push (from `<out>`).
2. Does the object already exist on the system?

   ```jsonc
   ["-q", "object", "structure", "<objectUrl>"]
   ```

   Exit `0` = it exists. Non-zero = it does not (or you have the wrong URL — check the message before
   concluding it is missing).
3. **It exists** → get the transport (§E), then update and activate:

   ```jsonc
   ["object", "set-source", "<objectUrl>", "--file", "<ABSOLUTE path>", "--transport", "<TR>"]
   ["object", "activate", "<objectUrl>"]
   ```

   `set-source` locks, PUTs, and unlocks in one stateful session.
4. **It does not exist** → get the transport (§E), then create with source and activate in one go:

   ```jsonc
   ["object", "create", "<kind>", "<NAME>", "--package", "<PKG>",
    "--description", "<short text>", "--source-file", "<ABSOLUTE path>",
    "--transport", "<TR>", "--activate"]
   ```

   `<kind>` is the alias for the object type (`program`, `class`, `interface`, `ddl`, …) — see
   [objects.md](objects.md) for the table and the per-kind flags.
5. `activate` exits `1` when the system reports `success: false`. The `messages` array names the line
   and the reason. Fix the source, write it to `<out>` again, and repeat from step 3.

Drop `--transport` entirely for `$TMP` and other local objects — passing one there is an error, not a
harmless extra.

---

## E. Get the transport request

**Rule: a write always goes into the transport request of the package that owns the object.** Never
invent a transport id, never reuse one from an earlier unrelated task, and never create a new one —
creating a transport is a human's decision.

**Skip this entire section** when the package is `$TMP` or the object is otherwise local: those are
not transported, and no `--transport` argument is passed.

Otherwise ask the system. There is no `adt` subcommand for this, so this is the one documented raw
call the skill allows:

```jsonc
["-q", "http", "request", "POST", "/sap/bc/adt/cts/transportchecks",
 "-H", "Accept: application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.transport.service.checkData",
 "--content-type", "application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.transport.service.checkData",
 "--data", "<?xml version=\"1.0\" encoding=\"UTF-8\"?><asx:abap xmlns:asx=\"http://www.sap.com/abapxml\" version=\"1.0\"><asx:values><DATA><DEVCLASS>ZPKG</DEVCLASS><OPERATION>I</OPERATION><URI>/sap/bc/adt/oo/classes/zcl_x</URI></DATA></asx:values></asx:abap>"]
```

Fill in two values:

- `DEVCLASS` — the package that owns the object. Take it from `object structure`, or from the package
  folder the file sits in inside the mirror.
- `URI` — the object's ADT URI (`adtUri` from the tree manifest, or the object URL you are pushing to).
- Leave `OPERATION` as `I`.

The response is XML and comes back parsed; read it under `asx:abap` → `asx:values` → `DATA`:

| Look at | Meaning | What to do |
|---|---|---|
| `RECORDING` empty and `TRANSPORTS` empty | The object is not under transport control | Push without `--transport` |
| `LOCKS.CTS_OBJECT_LOCK.LOCK_HOLDER.REQ_HEADER.TRKORR` | The object is **already locked into** a transport | Use exactly that `TRKORR`. This is the strongest form of "the package's transport" — stop here, ask nothing |
| `REQUESTS.CTS_REQUEST[].REQ_HEADER` | Transports you may record into | Filter to `AS4USER` = the current user and `TRSTATUS` `D` or `L` (modifiable). Exactly one → use it. Several → show `TRKORR` + `AS4TEXT` and **ask the user** |
| `MESSAGES.CTS_MESSAGE[]` with `SEVERITY` `E`, `A`, or `X` | The system refuses | Stop and report `TEXT` verbatim. Do not push |

If nothing usable comes back — no lock, no modifiable request — stop and tell the user which package
needs a transport request. Do not fall back to a transport from another package.
