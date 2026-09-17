# Package ZABAP_GENERATOR

> AbapGenerator

## Identity

| field | value |
| --- | --- |
| package | ZABAP_GENERATOR |
| parent | - |
| software_component | - |
| application_component | - |
| transport_layer | - |
| package_type | - |
| master_language | EN |
| responsible | URA2HC |
| changed_by/at | URA2HC / 2023-04-04T22:00:00Z |
| sub_packages | 2 |

### Sub-packages

- ZABAP_GENERATOR_RANGES
- ZABAP_GENERATOR_TEMPLATES

## Inventory

Total objects: **45**

| type | count |
| --- | --- |
| CLAS | 13 |
| PROG | 1 |
| FUGR | 1 |
| DOMA | 6 |
| DTEL | 13 |
| TABL | 4 |
| TTYP | 2 |
| MSAG | 1 |
| SUSH | 2 |
| TRAN | 1 |
| TOBJ | 1 |

## Files in this bundle

- `manifest.json` (~4.4k tok) — object-level metadata + inventory
- `structure.json` (~5.4k tok) — rich skeleton (classes, interfaces, programs, function groups)
- `dependencies.json` (~1.6k tok) — cross-object dependency graph (outbound edges)
- `metrics.json` (~1.3k tok) — per-class cyclomatic complexity + method length
- `ddic.json` (~2.1k tok) — DDIC descriptors (tables, data elements, domains)

## Dependency summary

- nodes (internal + external): **38**
- edges (outbound): **26**
- edge kinds:
  - callFunction: 21
  - includes: 1
  - instantiates: 1
  - readsTable: 3

## Metrics summary

- classes measured: **13**
- god classes (>30 methods): **0**
- top complexity hotspots:
  - ZCL_ABAP_GENERATOR_CLASS — max complexity 13, max method length 89
  - ZCL_ABAP_GENERATOR_REPORT — max complexity 13, max method length 80
  - ZCL_ABAP_GENERATOR — max complexity 4, max method length 17
  - ZCL_ABAP_GENERATOR_PACKAGE — max complexity 3, max method length 20
  - ZCX_ABAP_GEN — max complexity 1, max method length 7

## Recommended reading order for the LLM

1. **CONTEXT.md** (this file) — orient on what the package is and what's in this bundle.
2. **manifest.json** — full object inventory with adtcore metadata; pick which objects to focus on.
3. **structure.json** — class / interface / program skeletons with method signatures, attributes, events.
4. **dependencies.json** — follow call/inheritance/data-access edges to map information flow.
5. **metrics.json** — identify complexity hotspots that warrant deeper investigation.
6. Drill into specific sub-files only if the analysis step needs them (sources/, docs/, ddic.json, etc.).

## Token budget

- target model: `gpt-5-nano`
- soft cap: 89.6k tokens
- bundle estimate: **14.8k** tokens

_Generated at 2026-06-01T08:41:22.750Z by adt-cli `adt context build`._
