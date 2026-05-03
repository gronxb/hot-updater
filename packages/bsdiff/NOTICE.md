# Notices for @hot-updater/bsdiff

This package contains Hot Updater code plus a precompiled WebAssembly artifact
that incorporates third-party bsdiff and bzip2 implementations.

## Hot Updater package code

- Source: https://github.com/gronxb/hot-updater
- License: MIT
- Copyright: 2025-present Hot Updater contributors

## bsdiff

- Crate: `bsdiff` 0.2.1
- Source: https://github.com/space-wizards/bsdiff-rs
- Crates.io: https://crates.io/crates/bsdiff
- License: BSD-2-Clause

The Rust crate is a port of Matthew Endsley's bsdiff library:

- Source: https://github.com/mendsley/bsdiff
- Copyright: 2003-2005 Colin Percival
- Copyright: 2012 Matthew Endsley
- Modified: 2017 Pieter-Jan Briers
- Modified: 2021 Kornel Lesinski

Hot Updater uses this implementation to produce and apply the control/diff/extra
stream that is wrapped as an `ENDSLEY/BSDIFF43` patch.

## bzip2-rs

- Crate: `bzip2` 0.6.1
- Source: https://github.com/trifectatechfoundation/bzip2-rs
- Crates.io: https://crates.io/crates/bzip2
- License: MIT OR Apache-2.0
- Copyright: 2014-2025 Alex Crichton and Contributors

This distribution satisfies the `bzip2` crate's dual license under the MIT
license option.

## libbzip2-rs

- Crate: `libbz2-rs-sys` 0.2.2
- Source: https://github.com/trifectatechfoundation/libbzip2-rs
- Crates.io: https://crates.io/crates/libbz2-rs-sys
- License: bzip2-1.0.6
- Copyright: 1996-2021 Julian R Seward
- Copyright: 2019-2020 Federico Mena Quintero
- Copyright: 2021 Micah Snyder
- Copyright: 2024-2025 Trifecta Tech Foundation and contributors

`libbzip2-rs` is a Rust translation and derived work based on bzip2/libbzip2.
