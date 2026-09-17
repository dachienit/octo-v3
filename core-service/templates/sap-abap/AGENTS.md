This is an SAP ABAP workspace.

Use the vendored SAP ABAP skills under `skills/sap-abap` and `skills/sap-abap-cds` for ABAP development, ABAP Cloud, RAP, CDS views, SQL, unit testing, and performance work.

To reach a connected SAP system — reading or writing source, creating or activating objects, pushing code back with a transport request, ATC checks — use `skills/sap-adt-cli`. It runs through the `adt` tool; connecting a system and choosing a profile are done by the user in the UI.

To analyse an entire ABAP package end to end — resolve the system, clone it into `artifacts/`, and build a context bundle — use `skills/sap-abap-analysis-package`.

Prefer ABAP Cloud compatible APIs where appropriate. Preserve SAP object names, package names, transport context, CDS annotations, and authorization details when editing or generating artifacts.
