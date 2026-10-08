# Offline OpenAPI resources

The four JSON files are unmodified official OAI artifacts. Their dated URLs are the pins; the schema iteration applies to all OpenAPI 3.1 patch releases, including 3.1.1. The official schemas are informational; the [3.1.1 specification](https://spec.openapis.org/oas/v3.1.1.html) remains authoritative. These validators establish supported structural/dialect checks, not every normative or business constraint.

| File | Source | SHA-256 |
| --- | --- | --- |
| openapi-3.1-schema-2026-08-03.json | https://spec.openapis.org/oas/3.1/schema/2026-08-03 | 59f106413cb48c31299f96f024c938d3628aed6cd02cd14bcfb2fcaae7a130b6 |
| openapi-3.1-schema-base-2026-08-03.json | https://spec.openapis.org/oas/3.1/schema-base/2026-08-03 | ffdd07e28417bfa89de635d23a7476f7625497b8edd279f18c1424e613966d9a |
| oas-3.1-dialect-2024-11-10.json | https://spec.openapis.org/oas/3.1/dialect/2024-11-10 | 647f32dfff64949d5020a28ecd1af4ffeffb1e9c695f861a52255a8004e07460 |
| oas-3.1-meta-2024-11-10.json | https://spec.openapis.org/oas/3.1/meta/2024-11-10 | 80706a9a404affedbf84ac4dc1328c9ce0d2a00804cdfc4d95c0ddd0053121dd |

`LICENSE` is Apache-2.0 from [OAI/OpenAPI-Specification at aebfd1370825c08f605681f0b3e87bf604c731f4](https://github.com/OAI/OpenAPI-Specification/blob/aebfd1370825c08f605681f0b3e87bf604c731f4/LICENSE), SHA-256 `4948367c65e1ce06690e2cadc6e86fce1a6a6db55ef874ce4b78c0f472ce5f13`. Retain this license and source attribution in distribution.

## Bounded AJV compatibility normalization

`../../openapi-structure.schema.json` is derived from the structural schema above. Its only semantic edits are:

- `$id` becomes `urn:byeori:openapi-structure:1`, identifying the local adaptation.
- Four `$dynamicRef: "#meta"` values become `$ref: "#/$defs/schema"`, at `/$defs/components/properties/schemas/additionalProperties`, `/$defs/parameter/properties/schema`, `/$defs/media-type/properties/schema`, and `/$defs/header/properties/schema`.

The original defines `meta` dynamically inside `$defs.schema`. In installed AJV 8.20.0, the missing dynamic-anchor binding falls back to the root validator, incorrectly checking an embedded Schema Object as a whole OpenAPI document. The unmodified schema rejected the valid synthetic 3.1.1 fixture with `unevaluatedProperties` errors for `type`, `properties`, `required`, and `additionalProperties`. Static references restore the documented structural boundary (Schema Object is object/boolean); they do not claim embedded-schema validation.

Core independently checks every embedded Schema Object with the official OAS dialect/meta and AJV's bundled JSON Schema 2020-12 meta-schemas. Tests reject invalid nested types, required arrays, OAS discriminator fields, regex syntax, and unsupported dialects separately from invalid OpenAPI response structure. `ajv-formats` plus the media-range format validate the original format constraints. The schema-base original is retained for provenance; Core deliberately composes structural and embedded checks rather than invoking its incompatible dynamic reference chain. Only the OAS base dialect and JSON Schema 2020-12 dialect are supported offline. Remote document references are denied without fetching; local references use bounded project containment, typed targets, escaped pointers, and resource-scoped anchors.
