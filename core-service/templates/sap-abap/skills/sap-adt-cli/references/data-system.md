# Reference: data, system, services, transports, traces, debug, HTTP

`adt data`, `adt system`, `adt service`, `adt cts`, `adt trace`, `adt debug`, `adt http`. Examples are
the `argv` array you pass to the `adt` tool; every command targets the connection the user is working
in, with no profile argument.

---

## `adt data` — SQL & DDIC preview

```jsonc
["data", "sql", "SELECT carrier_id, customer_id FROM /DMO/BOOKING WHERE booking_id = 0005", "--rows", "5"]
["data", "ddic", "/DMO/TRAVEL", "--rows", "20", "--where", "status = 'O'"]
["data", "ddic-meta", "/DMO/TRAVEL"]
```

| Command | Purpose | Options |
|---|---|---|
| `sql <query...>` | Free-style ABAP SQL preview | `--rows <n>` (default 100) |
| `ddic <entity>` | Data preview of a DDIC table / CDS view | `--rows <n>`, `--where <sql>` |
| `ddic-meta <entity>` | Column metadata of a DDIC entity | — |

The whole query is one `argv` element — no quoting games, and no shell to mangle it.

---

## `adt system` — discovery & metadata

```jsonc
["system", "discovery"]                                    // ADT service document
["system", "core-discovery"]                               // also primes the CSRF token
["system", "object-types", "--name", "Z*", "--max", "50"]  // object type catalog
["system", "dumps", "--user", "DEVELOPER", "--top", "20"]  // short dumps
```

| Command | Purpose | Options |
|---|---|---|
| `discovery` | Root service document | — |
| `core-discovery` | Core discovery + prime CSRF | — |
| `graph` | Compatibility graph | — |
| `feeds` | Available feeds | — |
| `object-types` | Object type catalog | `--name` (default `*`), `--max` (999), `--data` (`usedByProvider`) |
| `type-structure` | Type structure (POST) | — |
| `users` | System users | — |
| `dumps` | Short dumps | `--user <user>`, `--top <n>` (50) |

`system dumps` is the fastest way to find out why an activated program blew up at runtime.

---

## `adt service` — business service bindings

```jsonc
["service", "binding", "zui_travel_o2"]
["service", "odata-v2", "ZSB_DEMO", "--service", "ZUI_TRAVEL", "--service-def", "ZSRVD_DEMO"]
```

| Command | Purpose | Options |
|---|---|---|
| `binding <name>` | Read a service binding | — |
| `odata-v2 <binding>` | OData v2 service details | `--service <name>` (req), `--service-def <def>` (req), `--version` (0001) |

---

## `adt cts` — Change & Transport System

These commands read **saved transport search configurations**. They do **not** tell you which
transport an object belongs to — for that, use the transport check in
[workflows.md §E](workflows.md), which is the only supported way to pick a transport for a write.

```jsonc
["cts", "configurations"]                    // list saved search configs
["cts", "configuration", "<configId>"]       // read one (returns its etag)
["cts", "list", "--config", "<configId>"]    // transports matching that config
```

| Command | Purpose | Options |
|---|---|---|
| `config-metadata` | Search configuration metadata | — |
| `configurations` | List saved search configs | — |
| `configuration <configId>` | Read one config (returns etag) | — |
| `save-configuration <configId>` | Update a config (PUT, `If-Match`) | `--etag <e>` (req), `--file <xml>` (req, absolute path) |
| `list` | List transports for a config | `--config <configId>` (req), `--no-targets` |

An object is assigned to a transport by passing `--transport <TR>` to `create` / `set-source` /
`delete` — there is no separate "assign" command.

---

## `adt trace` — ABAP runtime traces

```jsonc
["trace", "list", "--user", "DEVELOPER"]
["trace", "hitlist", "<traceId>"]
["trace", "statements", "<traceId>", "--id", "1", "--with-details"]
```

| Command | Purpose | Options |
|---|---|---|
| `list` | List traces | `--user <user>` |
| `requests` | List traced requests | `--user <user>` |
| `hitlist <traceId>` | Hitlist for a trace | `--system-events` |
| `db <traceId>` | DB accesses | `--system-events` (default true) |
| `statements <traceId>` | Aggregated call tree | `--id <n>`, `--with-details`, `--auto <pct>` (80), `--system-events` |
| `parameters` | POST trace params XML → `parametersId` | `--file <xml>` (req, absolute path) |
| `create` | Create a trace configuration | `--description`, `--user`, `--client`, `--process-type`, `--object-type`, `--expires`, `--parameters-id` (all req); `--max-exec` (3), `--server` (`*`) |
| `delete <traceConfigId>` | Delete a trace config | — |

---

## `adt debug` — debugger control

```jsonc
["debug", "status", "--user", "DEVELOPER"]
["debug", "breakpoint", "set", "/sap/bc/adt/programs/programs/zroman/source/main", "--line", "25"]
```

| Command | Purpose | Options |
|---|---|---|
| `discovery` | Debugger discovery feed | — |
| `status` | List listeners | `--mode <m>` (user), `--user <user>` |
| `listen` | Start listening | `--mode`, `--user` |
| `settings` | POST debugger settings | `--file <file>` \| `--default` |
| `breakpoint set <objectUri>` | Set a line breakpoint | `--line <n>` (req), `--program`, `--include`, `--user`, `--mode` |
| `breakpoint delete <breakpointId>` | Delete a breakpoint | `--user`, `--mode` |

`debug listen` is a long poll: it holds the connection until an event arrives or the tool's timeout
fires. Do not start one unless the user asked for a debugging session.

---

## `adt http` — generic request

> **Only two uses are allowed** (SKILL.md rule 3): the transport check in
> [workflows.md §E](workflows.md), and reading an object's raw metadata by the `adtUri` the tree
> manifest already gave you. Anything else means there is no documented command for the need —
> escalate to a human instead of guessing a path.

```jsonc
// Raw object metadata for an object with no text source
["-q", "--raw", "http", "request", "GET", "/sap/bc/adt/ddic/tables/ztable"]
```

| Command | Purpose | Options |
|---|---|---|
| `request <METHOD> <path>` (alias `req`) | Generic ADT call; auth, cookies and CSRF handled for you | `-H/--header <h...>`, `--content-type <mime>`, `--data <text>`, `--data-file <path>`, `--no-fail` |

XML responses come back parsed into JSON unless you pass `--raw`. Pass `--raw` when you intend to save
the body verbatim; leave it off when you want to read values out of the response.

`adt http list` / `adt http run` execute `.http` files. They are a developer convenience and have no
use from here.
