# `sapgit` tool reference

## SAP Git-Flow & Unified Version Control with `sapgit`
 
To align centralized SAP central development with modern local version control, this workspace uses the unified `sapgit` capability tool. The local directory `artifacts/<connection_name>/` acts as the Git repository, and the SAP server acts as the remote host.
 
As an AI agent, you must **NEVER** use raw terminal `git` commands or direct `adt` commands inside the artifacts directory. Instead, **use the `sapgit` tool for all version control and SAP interactions.**
 
### The `sapgit` Tool Reference
 
Execute the `sapgit` tool with the following subcommands:
* **Local Git Actions**: `"status"`, `"diff"`, `"add"`, `"commit"`, `"log"`, `"branch"`, `"switch"`, `"merge"`, `"restore"`
* **SAP Sync Actions**: `"clone"`, `"pull"`, `"push"`, `"activate"`, `"check"`
 
---
 
### Step-by-Step Developer Workflow
 
Follow this linear lifecycle for every task:
 
#### Clone & Hydrate the SAP Package
Before reading or editing, hydrate the target package's placeholder files from SAP and initialize local Git:
```json
// Call the sapgit tool
sapgit(
  command: "clone",
  connectionName: "<SAP_SYSSTEM>",
  packageName: "<SAP_PACKAGE>"
)
```
*Mechanics*: This lists package objects, materializes the directory tree under `artifacts/SAP_SYSSTEM/`, pulls all object sources from SAP, and runs `git init` with an automatic `.gitignore` for `.adt/`, `.artifacts/`, `.scratchpad/` metadata.