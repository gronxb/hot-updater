# hkmqe0 Android diagnostic evidence

These fixtures were read from the two Android emulators left by
`job-20260914135631-hkmqe0` after its shard runs completed on commit
`247b3e359ec265e0e798ce8169fc4c00728679f2`.

| Shard | Device | Runtime journal SHA-256 | Eligible log SHA-256 |
| --- | --- | --- | --- |
| s1 | `emulator-5554` | `9b28d166d78e69f1d42da081d02a8c423f96062af2e282b15e916ba0263ffb42` | `e352ca97f6901f168efc86a9b770b5059bedf6b2473ecd3abe09f773ce439958` |
| s2 | `emulator-5556` | `81e28642f944b6dfa89d193e4ae9add2c94e9ad894909c261021c042e80e8421` | `f02345e6bc5b5899623d081cb6244d2f32558575f896f1bba61a1bddfa2df103` |

The hashes cover the device or logcat payload bytes without the repository's
final newline. Tests remove that one newline before hashing.

The preserved bot artifacts did not contain the action-result or screen-state
HTTP response bodies. Tests therefore wrap each native journal in the existing,
documented control-protocol envelope. This proves that the native log and
journal chain is eligible when the control envelope agrees with it. It does not
claim that the missing hkmqe0 HTTP responses had that shape.
