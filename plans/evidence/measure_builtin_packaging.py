#!/usr/bin/env python3

import json
import subprocess
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from zipfile import ZipFile


REPO_ROOT = Path(__file__).resolve().parents[2]
EXAMPLE_ROOT = REPO_ROOT / "examples" / "v0.85.0"
ANDROID_BUILD = EXAMPLE_ROOT / "android" / "app" / "build"
IOS_APP = (
    EXAMPLE_ROOT
    / "ios"
    / "build-m0"
    / "Build"
    / "Products"
    / "Release-iphonesimulator"
    / "HotUpdaterExample.app"
)


def digest(data: bytes) -> str:
    return sha256(data).hexdigest()


def file_record(path: Path) -> dict[str, object]:
    data = path.read_bytes()
    return {"byteSize": len(data), "sha256": digest(data)}


def classify(expected: bytes, candidates: list[dict[str, object]]) -> str:
    if not candidates:
        return "missing"
    if any(candidate["sha256"] == digest(expected) for candidate in candidates):
        return "reusable"
    return "mismatched"


def load_android_splits() -> tuple[dict[str, bytes], list[str]]:
    entries: dict[str, bytes] = {}
    split_names: list[str] = []
    with ZipFile(ANDROID_BUILD / "m0-device.apks") as archive:
        for split_name in sorted(
            name for name in archive.namelist() if name.endswith(".apk")
        ):
            split_names.append(split_name)
            with ZipFile(BytesIO(archive.read(split_name))) as split:
                for entry_name in split.namelist():
                    entries[f"{split_name}!/{entry_name}"] = split.read(entry_name)
    return entries, split_names


def android_candidates(
    logical_path: str, entries: dict[str, bytes]
) -> list[dict[str, object]]:
    if logical_path == "index.android.bundle":
        suffix = "/assets/index.android.bundle"
    else:
        directory, filename = logical_path.split("/", 1)
        suffixes = (
            f"/res/{directory}/{filename}",
            f"/res/{directory}-v4/{filename}",
        )
        return [
            {
                "source": source,
                "byteSize": len(data),
                "sha256": digest(data),
            }
            for source, data in entries.items()
            if source.endswith(suffixes)
        ]

    return [
        {
            "source": source,
            "byteSize": len(data),
            "sha256": digest(data),
        }
        for source, data in entries.items()
        if source.endswith(suffix)
    ]


def measure_android() -> dict[str, object]:
    ota_root = EXAMPLE_ROOT / "dist-m0-android"
    entries, split_names = load_android_splits()
    targets = [
        ("index.android.bundle", ota_root / "index.android.bundle.hbc"),
        *(
            (path.relative_to(ota_root).as_posix(), path)
            for path in sorted(ota_root.rglob("*.png"))
        ),
    ]
    rows = []
    for logical_path, path in targets:
        data = path.read_bytes()
        candidates = android_candidates(logical_path, entries)
        rows.append(
            {
                "logicalPath": logical_path,
                "targetByteSize": len(data),
                "targetSha256": digest(data),
                "result": classify(data, candidates),
                "candidates": candidates,
            }
        )

    counts = {
        result: sum(row["result"] == result for row in rows)
        for result in ("reusable", "missing", "mismatched")
    }
    return {
        "releaseArtifacts": {
            "aab": file_record(
                ANDROID_BUILD / "outputs" / "bundle" / "release" / "app-release.aab"
            ),
            "apk": file_record(
                ANDROID_BUILD / "outputs" / "apk" / "release" / "app-release.apk"
            ),
        },
        "deviceSpec": json.loads(
            (ANDROID_BUILD / "m0-device-spec.json").read_text()
        ),
        "installedSplits": split_names,
        "counts": counts,
        "files": rows,
    }


def measure_ios() -> dict[str, object]:
    ota_root = EXAMPLE_ROOT / "dist-m0-ios"
    targets = [
        (
            "index.ios.bundle",
            ota_root / "index.ios.bundle.hbc",
            IOS_APP / "main.jsbundle",
        ),
        *(
            (
                path.relative_to(ota_root).as_posix(),
                path,
                IOS_APP / path.relative_to(ota_root),
            )
            for path in sorted(ota_root.rglob("*.png"))
        ),
    ]
    rows = []
    for logical_path, target_path, builtin_path in targets:
        target_data = target_path.read_bytes()
        candidates = []
        if builtin_path.exists():
            builtin_data = builtin_path.read_bytes()
            candidates.append(
                {
                    "source": builtin_path.relative_to(IOS_APP).as_posix(),
                    "byteSize": len(builtin_data),
                    "sha256": digest(builtin_data),
                }
            )
        rows.append(
            {
                "logicalPath": logical_path,
                "targetByteSize": len(target_data),
                "targetSha256": digest(target_data),
                "result": classify(target_data, candidates),
                "candidates": candidates,
            }
        )

    counts = {
        result: sum(row["result"] == result for row in rows)
        for result in ("reusable", "missing", "mismatched")
    }
    return {"app": str(IOS_APP.relative_to(REPO_ROOT)), "counts": counts, "files": rows}


def main() -> None:
    revision = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, text=True
    ).strip()
    result = {
        "schemaVersion": 1,
        "revision": revision,
        "example": "examples/v0.85.0",
        "buildSettings": {
            "android": "Release AAB/APK; Hermes; Re.Pack native bundle; bare OTA bundle",
            "ios": "Release iOS Simulator app; Hermes; Re.Pack native bundle; bare OTA bundle; code signing disabled",
        },
        "android": measure_android(),
        "ios": measure_ios(),
    }
    print(json.dumps(result, indent=2) + "\n", end="")


if __name__ == "__main__":
    main()
