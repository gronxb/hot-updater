#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path


def run_command(
    command: list[str],
    cwd: Path,
    *,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        check=check,
        capture_output=True,
        text=True,
    )


def git(
    cwd: Path,
    *args: str,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    return run_command(["git", *args], cwd, check=check)


def first_line(text: str) -> str:
    return text.strip().splitlines()[0] if text.strip() else ""


def dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value and value not in seen:
            result.append(value)
            seen.add(value)
    return result


def score_change(change: Change) -> int:
    score = 0
    if not is_docs_or_tooling(change):
        score += 10
    if "recovery" in change.risk_tags:
        score += 8
    if "ota-runtime" in change.risk_tags:
        score += 6
    if "visible-ui" in change.risk_tags:
        score += 4
    if set(change.area_tags) & {
        "core",
        "react-native",
        "hot-updater",
        "plugins",
        "native",
        "example",
    }:
        score += 4
    if is_docs_or_tooling(change):
        score -= 3
    return score


def prioritize_changes(changes: list[Change]) -> list[Change]:
    indexed = list(enumerate(changes))
    indexed.sort(key=lambda item: (-score_change(item[1]), item[0]))
    return [change for _, change in indexed]


@dataclass
class PRInfo:
    number: int | None
    title: str | None
    url: str | None
    base_ref_name: str | None
    head_ref_name: str | None


@dataclass
class Change:
    status: str
    path: str
    old_path: str | None
    added: int | None
    deleted: int | None
    area_tags: list[str]
    risk_tags: list[str]


@dataclass
class Summary:
    repo_root: str
    current_branch: str
    pr: PRInfo | None
    base_branch: str
    base_source: str
    resolved_base_ref: str
    merge_base: str
    diff_range: str
    shortstat: str
    changed_files: list[Change]
    scenario_hints: list[str]
    patch_excerpts: dict[str, str]
    local_worktree: list[str]
    max_listed_files: int


def command_exists(name: str) -> bool:
    return shutil.which(name) is not None


def detect_pr_info(cwd: Path, current_branch: str) -> PRInfo | None:
    if not command_exists("gh"):
        return None

    result = run_command(
        [
            "gh",
            "pr",
            "view",
            "--json",
            "number,title,url,baseRefName,headRefName",
        ],
        cwd,
        check=False,
    )
    if result.returncode != 0 or not result.stdout.strip():
        return None

    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None

    head_ref = payload.get("headRefName")
    if head_ref and head_ref != current_branch:
        return None

    return PRInfo(
        number=payload.get("number"),
        title=payload.get("title"),
        url=payload.get("url"),
        base_ref_name=payload.get("baseRefName"),
        head_ref_name=head_ref,
    )


def detect_default_branch(cwd: Path) -> str | None:
    if command_exists("gh"):
        result = run_command(
            ["gh", "repo", "view", "--json", "defaultBranchRef"],
            cwd,
            check=False,
        )
        if result.returncode == 0 and result.stdout.strip():
            try:
                payload = json.loads(result.stdout)
            except json.JSONDecodeError:
                payload = {}
            default_branch = (
                payload.get("defaultBranchRef", {}) or {}
            ).get("name")
            if default_branch:
                return default_branch

    head = git(
        cwd,
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        check=False,
    )
    if head.returncode == 0:
        ref = first_line(head.stdout)
        if ref.startswith("refs/remotes/origin/"):
            return ref.removeprefix("refs/remotes/origin/")

    for candidate in ("main", "master", "develop"):
        if ref_exists(cwd, f"origin/{candidate}") or ref_exists(cwd, candidate):
            return candidate

    return None


def ref_exists(cwd: Path, ref: str) -> bool:
    result = git(
        cwd,
        "rev-parse",
        "--verify",
        "--quiet",
        f"{ref}^{{commit}}",
        check=False,
    )
    return result.returncode == 0


def fetch_origin_ref(cwd: Path, base_branch: str) -> str | None:
    if not base_branch:
        return None

    remote_branch = base_branch.removeprefix("origin/")
    resolved_ref = f"origin/{remote_branch}"
    if ref_exists(cwd, resolved_ref):
        return resolved_ref

    result = git(
        cwd,
        "fetch",
        "origin",
        f"{remote_branch}:refs/remotes/origin/{remote_branch}",
        check=False,
    )
    if result.returncode == 0 and ref_exists(cwd, resolved_ref):
        return resolved_ref
    return None


def resolve_base_ref(
    cwd: Path,
    *,
    requested_base: str | None,
    pr_info: PRInfo | None,
) -> tuple[str, str, str]:
    if requested_base:
        base_branch = requested_base
        base_source = "argument"
    elif pr_info and pr_info.base_ref_name:
        base_branch = pr_info.base_ref_name
        base_source = "gh-pr"
    else:
        default_branch = detect_default_branch(cwd)
        if not default_branch:
            raise RuntimeError(
                "Could not detect a PR base branch or a default branch."
            )
        base_branch = default_branch
        base_source = "default-branch"

    candidates = [base_branch]
    if not base_branch.startswith("origin/"):
        candidates.insert(0, f"origin/{base_branch}")

    for candidate in dedupe(candidates):
        if ref_exists(cwd, candidate):
            return base_branch, base_source, candidate

    fetched_ref = fetch_origin_ref(cwd, base_branch)
    if fetched_ref:
        return base_branch, base_source, fetched_ref

    joined = ", ".join(dedupe(candidates))
    raise RuntimeError(
        f"Could not resolve base ref for '{base_branch}'. Tried: {joined}"
    )


def parse_numstats(raw: str) -> dict[str, tuple[int | None, int | None]]:
    stats: dict[str, tuple[int | None, int | None]] = {}
    for line in raw.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        added_raw, deleted_raw = parts[0], parts[1]
        path = parts[-1]
        added = None if added_raw == "-" else int(added_raw)
        deleted = None if deleted_raw == "-" else int(deleted_raw)
        stats[path] = (added, deleted)
    return stats


def classify_change(path: str) -> tuple[list[str], list[str]]:
    lower = path.lower()
    areas: list[str] = []
    risks: list[str] = []

    if path.startswith("examples/v0.85.0/ios/"):
        areas.extend(["example", "ios", "native"])
    elif path.startswith("examples/v0.85.0/android/"):
        areas.extend(["example", "android", "native"])
    elif path.startswith("examples/v0.85.0/"):
        areas.extend(["example", "js"])
    elif path.startswith("packages/core/"):
        areas.extend(["core", "shared"])
    elif path.startswith("packages/react-native/"):
        areas.extend(["react-native", "shared"])
    elif path.startswith("packages/hot-updater/"):
        areas.extend(["hot-updater", "shared"])
    elif path.startswith("packages/console/"):
        areas.append("console")
    elif path.startswith("packages/"):
        areas.append("packages")
    elif path.startswith("plugins/"):
        areas.append("plugins")
    elif path.startswith("docs/"):
        areas.append("docs")
    elif path.startswith(".github/") or path.startswith("scripts/"):
        areas.append("tooling")
    else:
        areas.append("repo")

    if lower.endswith((".md", ".mdx")):
        risks.append("docs-like")
    if any(
        token in lower
        for token in (
            "bundle",
            "manifest",
            "runtime",
            "rollout",
            "update",
            "deploy",
            "asset",
        )
    ):
        risks.append("ota-runtime")
    if any(
        token in lower
        for token in (
            "crash",
            "rollback",
            "recover",
            "launch-report",
            "bundle-store",
            "notifyappready",
        )
    ):
        risks.append("recovery")
    if path.startswith("examples/v0.85.0/") and "/ios/" not in path:
        if "/android/" not in path:
            risks.append("visible-ui")
    if "/ios/" in path or lower.endswith((".m", ".mm", ".swift", ".pbxproj")):
        risks.append("ios")
    if "/android/" in path or lower.endswith(
        (".kt", ".java", ".gradle", "androidmanifest.xml")
    ):
        risks.append("android")
    if lower.endswith(
        (
            "package.json",
            "pnpm-lock.yaml",
            "tsconfig.json",
            "biome.json",
            "vitest.config.ts",
        )
    ):
        risks.append("tooling")

    return dedupe(areas), dedupe(risks)


def build_changes(cwd: Path, diff_range: str) -> list[Change]:
    name_status = git(
        cwd,
        "diff",
        "--find-renames",
        "--name-status",
        diff_range.split("..", 1)[0],
        "HEAD",
    )
    numstats = git(
        cwd,
        "diff",
        "--find-renames",
        "--numstat",
        diff_range.split("..", 1)[0],
        "HEAD",
    )
    numstats_by_path = parse_numstats(numstats.stdout)

    changes: list[Change] = []
    for line in name_status.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        status = parts[0][0]
        old_path: str | None = None
        if status in {"R", "C"} and len(parts) >= 3:
            old_path = parts[1]
            path = parts[2]
        else:
            path = parts[1]
        added, deleted = numstats_by_path.get(path, (None, None))
        area_tags, risk_tags = classify_change(path)
        changes.append(
            Change(
                status=status,
                path=path,
                old_path=old_path,
                added=added,
                deleted=deleted,
                area_tags=area_tags,
                risk_tags=risk_tags,
            )
        )
    return changes


def is_docs_or_tooling(change: Change) -> bool:
    non_runtime_areas = {"docs", "tooling"}
    non_runtime_risks = {"docs-like", "tooling"}
    return all(tag in non_runtime_areas for tag in change.area_tags) or (
        change.risk_tags
        and all(tag in non_runtime_risks for tag in change.risk_tags)
    )


def derive_scenario_hints(changes: list[Change]) -> list[str]:
    if not changes:
        return ["No committed changes exist in the selected diff range."]

    impactful = [change for change in changes if not is_docs_or_tooling(change)]
    if not impactful:
        return [
            "Diff looks docs or tooling only. Explain that there is no meaningful "
            "OTA E2E scenario to run."
        ]

    hints: list[str] = []
    risk_tags = {tag for change in impactful for tag in change.risk_tags}
    area_tags = {tag for change in impactful for tag in change.area_tags}

    needs_recovery = bool(
        risk_tags & {"recovery"}
        or area_tags & {"core", "react-native", "hot-updater", "native"}
    )

    if needs_recovery:
        hints.append(
            "Include a stable deploy plus a crash-and-recovery phase."
        )
    else:
        hints.append("Start with a stable-only OTA verification flow.")

    has_ios = "ios" in risk_tags or "ios" in area_tags
    has_android = "android" in risk_tags or "android" in area_tags
    shared_change = bool(
        area_tags
        & {"core", "react-native", "hot-updater", "shared", "plugins", "js"}
    )

    if shared_change or (has_ios and has_android):
        hints.append("Run both platforms, one at a time.")
    elif has_ios:
        hints.append("Prioritize iOS first.")
    elif has_android:
        hints.append("Prioritize Android first.")
    else:
        hints.append("Run both platforms if the changed behavior is shared.")

    if not any("visible-ui" in change.risk_tags for change in impactful):
        hints.append(
            "Add the smallest temporary visible marker if the changed behavior "
            "is not already surfaced in the example UI."
        )

    if risk_tags & {"ota-runtime"} or area_tags & {"shared", "plugins"}:
        hints.append(
            "Verify both UI evidence and local bundle-store metadata."
        )

    return hints


def collect_patch_excerpts(
    cwd: Path,
    diff_range: str,
    changes: list[Change],
    *,
    max_files: int,
    max_lines: int,
    context: int,
) -> dict[str, str]:
    excerpts: dict[str, str] = {}
    base_ref = diff_range.split("..", 1)[0]
    prioritized = prioritize_changes(changes)
    for change in prioritized[:max_files]:
        result = git(
            cwd,
            "diff",
            "--find-renames",
            "--no-color",
            f"--unified={context}",
            base_ref,
            "HEAD",
            "--",
            change.path,
        )
        lines = result.stdout.strip().splitlines()
        if not lines:
            continue
        excerpt = "\n".join(lines[:max_lines]).strip()
        if len(lines) > max_lines:
            excerpt = f"{excerpt}\n... [truncated]"
        excerpts[change.path] = excerpt
    return excerpts


def collect_local_worktree(cwd: Path) -> list[str]:
    status = git(cwd, "status", "--short", check=False)
    return [line for line in status.stdout.splitlines() if line]


def format_change(change: Change) -> str:
    counts = []
    if change.added is not None:
        counts.append(f"+{change.added}")
    if change.deleted is not None:
        counts.append(f"-{change.deleted}")
    count_text = f" ({' '.join(counts)})" if counts else ""
    rename_text = f" <= {change.old_path}" if change.old_path else ""
    tag_text = ", ".join(change.area_tags + change.risk_tags)
    return (
        f"- {change.status} {change.path}{rename_text}{count_text}"
        f" [{tag_text}]"
    )


def print_human(summary: Summary) -> None:
    print(f"Repo root: {summary.repo_root}")
    print(f"Current branch: {summary.current_branch}")
    if summary.pr:
        pr_bits = []
        if summary.pr.number is not None:
            pr_bits.append(f"#{summary.pr.number}")
        if summary.pr.title:
            pr_bits.append(summary.pr.title)
        if summary.pr.url:
            pr_bits.append(summary.pr.url)
        print(f"PR: {' | '.join(pr_bits)}")
    else:
        print("PR: none detected")

    print(f"Base branch: {summary.base_branch} ({summary.base_source})")
    print(f"Resolved base ref: {summary.resolved_base_ref}")
    print(f"Merge base: {summary.merge_base}")
    print(f"Diff range: {summary.diff_range}")
    print(f"Shortstat: {summary.shortstat or 'No diff'}")
    print()

    prioritized = prioritize_changes(summary.changed_files)
    print("Changed files:")
    if prioritized:
        shown = prioritized[: summary.max_listed_files]
        for change in shown:
            print(format_change(change))
        omitted = len(prioritized) - len(shown)
        if omitted > 0:
            print(f"- ... {omitted} more files omitted")
    else:
        print("- none")
    print()

    print("Scenario hints:")
    for hint in summary.scenario_hints:
        print(f"- {hint}")
    print()

    print("Patch excerpts:")
    if summary.patch_excerpts:
        for path, excerpt in summary.patch_excerpts.items():
            print(f"=== {path} ===")
            print(excerpt)
            print()
    else:
        print("- none")
        print()

    print("Local worktree differences:")
    if summary.local_worktree:
        for line in summary.local_worktree:
            print(f"- {line}")
    else:
        print("- clean")


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Summarize the current PR diff against its base branch for "
            "PR-aware OTA E2E scenario selection."
        )
    )
    parser.add_argument(
        "--base",
        help="Explicit base branch or ref to compare against.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print machine-readable JSON instead of human output.",
    )
    parser.add_argument(
        "--max-files",
        type=int,
        default=8,
        help="Maximum number of files to include in patch excerpts.",
    )
    parser.add_argument(
        "--max-patch-lines",
        type=int,
        default=40,
        help="Maximum number of lines to keep per patch excerpt.",
    )
    parser.add_argument(
        "--max-listed-files",
        type=int,
        default=60,
        help="Maximum number of changed files to show in human output.",
    )
    parser.add_argument(
        "--context",
        type=int,
        default=2,
        help="Diff context lines to keep around each patch excerpt.",
    )
    args = parser.parse_args()

    repo_root = Path(
        first_line(
            git(Path.cwd(), "rev-parse", "--show-toplevel").stdout
        )
    ).resolve()
    current_branch = first_line(
        git(repo_root, "branch", "--show-current").stdout
    )
    pr_info = detect_pr_info(repo_root, current_branch)

    try:
        base_branch, base_source, resolved_base_ref = resolve_base_ref(
            repo_root,
            requested_base=args.base,
            pr_info=pr_info,
        )
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 1

    merge_base = first_line(
        git(repo_root, "merge-base", "HEAD", resolved_base_ref).stdout
    )
    diff_range = f"{merge_base}..HEAD"
    shortstat = first_line(
        git(repo_root, "diff", "--shortstat", merge_base, "HEAD").stdout
    )
    changes = build_changes(repo_root, diff_range)
    scenario_hints = derive_scenario_hints(changes)
    patch_excerpts = collect_patch_excerpts(
        repo_root,
        diff_range,
        changes,
        max_files=args.max_files,
        max_lines=args.max_patch_lines,
        context=args.context,
    )
    local_worktree = collect_local_worktree(repo_root)

    summary = Summary(
        repo_root=str(repo_root),
        current_branch=current_branch,
        pr=pr_info,
        base_branch=base_branch,
        base_source=base_source,
        resolved_base_ref=resolved_base_ref,
        merge_base=merge_base,
        diff_range=diff_range,
        shortstat=shortstat,
        changed_files=changes,
        scenario_hints=scenario_hints,
        patch_excerpts=patch_excerpts,
        local_worktree=local_worktree,
        max_listed_files=args.max_listed_files,
    )

    if args.json:
        payload = asdict(summary)
        print(json.dumps(payload, indent=2, ensure_ascii=False))
    else:
        print_human(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
