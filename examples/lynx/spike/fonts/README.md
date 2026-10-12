# Managed font fixtures

Unmodified Inter Regular and Inter Black files were copied from Octane commit
`c31f629185f7d768c821557f6fb49dc46daf671c`, under
`benchmarks/tanstack-com/react/public/fonts/`. Inter is licensed under the
included SIL Open Font License (`OFL.txt`), retrieved from
<https://github.com/rsms/inter/blob/master/LICENSE.txt> on 2026-09-11.

The fixture copies Regular for A and Black for B/C to the same artifact path,
`assets/probe.ttf`. It leaves the font bytes and internal names unchanged.

| Source file       | SHA-256                                                            |
| ----------------- | ------------------------------------------------------------------ |
| Inter-Regular.ttf | `1b08e7fc267a5c7e1d614100f604b83e7e8a0be241f0f288faa2b3ac93a683ba` |
| Inter-Black.ttf   | `68be2a10f64af792a4b1feaecb07e0d0363a6252290bc2c4de9f4cde5de13397` |

The native host must prove font resource resolution and cache identity. A JS
`lynx.addFont` callback alone does not prove which font bytes were loaded.
