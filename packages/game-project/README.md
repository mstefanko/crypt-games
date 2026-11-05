# M1 game definitions

This package is separate from Pocket Score's `@onepage/project`. `src/index.ts` exposes typed definitions and a bounded hand-written content codec. `src/runtime.ts` exposes only pure types, fixed-unit constants and bounded checkpoint primitives. Authoring JSON Schema and TypeBox validation live in the separate `src/authoring.ts` export.

`validateDefinitions(raw)` copies validated values into deeply immutable definitions. It rejects unknown fields, unsupported versions/rules, unsafe/fractional integers, content caps, missing/duplicate IDs, embedded spawns, blocked platform paths/rider clearance and malformed scenario input transitions. `parseDefinitions(json)` additionally bounds source bytes and nesting before parsing. Errors expose the shared diagnostic shape including JSON pointers. `canonicalDefinitions` produces the gameplay bytes whose SHA-256 is computed once by host/tooling.

The example manifest references independent JSON documents by stable ID. A room or strike only needs data in its supported document kind and the manifest reference list. Level width/height and tile size are logical pixels; authored shape, spawn, platform, speed and acceleration numbers are fixed units (256 units per pixel). Platforms are horizontal; one-way geometry catches downward crossings only. Appearance has no gameplay authority.
