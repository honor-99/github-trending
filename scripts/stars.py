#!/usr/bin/env python3
"""用 GraphQL 一次批量刷新上榜项目的实时 star → data/stars-live.json

为什么是 GraphQL 而不是 REST：
- REST `repos/{o}/{r}` 一条仓库一次请求，未认证限额 **60 次/小时/IP**（本机出口常被打满），
  68 个仓库根本不够用；带 token 也只能 5000 次/小时，但依然是 68 次。
- GraphQL 一个请求可以放多个 `repository(owner:,name:){stargazerCount}` 别名，
  68 个仓库 → 2 个请求（chunk=40）。配额按点数算，这种查询几乎不消耗。

口径（2026-11-18 与用户确认）
----------------------------
- 只刷新 `data/history.json` 里出现过的项目（= 历史榜单的全部行），不做全站扫描。
- **排序仍按快照口径**（`stars_total` 上榜时的累计值），本文件只提供「现在多少 star」，
  前端在数字旁边标注实时值与刷新时间，不参与排序 —— 否则「历史榜单」会变成另一个总榜。
- 失败不阻断：某个仓库 404/改名/网络抖动都只跳过，保留上一次的值（若没有就不写该条）。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CST = timezone(timedelta(hours=8))
CHUNK = 40  # 每个 GraphQL 请求放多少个仓库别名


def gh_bin() -> str:
    found = __import__("shutil").which("gh")
    if found:
        return found
    for cand in (
        Path.home() / ".local" / "bin" / "gh",
        Path("/usr/local/bin/gh"),
        Path("/usr/bin/gh"),
        Path("/snap/bin/gh"),
    ):
        if cand.exists():
            return str(cand)
    return "gh"


GH = gh_bin()


def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default


def build_query(names: list[str]) -> str:
    parts = []
    for i, full in enumerate(names):
        owner, _, repo = full.partition("/")
        # 名字里可能有引号（极少），GraphQL 字符串要转义
        owner = owner.replace('"', '\\"')
        repo = repo.replace('"', '\\"')
        parts.append(f'  r{i}: repository(owner: "{owner}", name: "{repo}") {{ stargazerCount }}')
    return "{\n" + "\n".join(parts) + "\n}"


def fetch_chunk(names: list[str]) -> dict[str, int]:
    """返回 {full_name: stars}；整个请求失败返回 {}（调用方保留旧值）。"""
    try:
        proc = subprocess.run(
            [GH, "api", "graphql", "-f", f"query={build_query(names)}"],
            capture_output=True, text=True, timeout=60,
        )
    except (subprocess.SubprocessError, OSError) as e:
        print(f"[warn] gh 调用失败：{type(e).__name__}: {e}", file=sys.stderr)
        return {}
    if proc.returncode != 0:
        print(f"[warn] graphql 失败（{proc.returncode}）：{(proc.stderr or '').strip()[:200]}",
              file=sys.stderr)
        return {}
    try:
        payload = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        print("[warn] graphql 返回非 JSON", file=sys.stderr)
        return {}

    data = payload.get("data") or {}
    out: dict[str, int] = {}
    for i, full in enumerate(names):
        node = data.get(f"r{i}") or {}
        stars = node.get("stargazerCount")
        if isinstance(stars, int):
            out[full] = stars
    # GraphQL 对 404/改名会返回 errors 且 data.rN = null，逐条告警但不中断
    for err in payload.get("errors") or []:
        msg = str(err.get("message") or "")[:120]
        print(f"[warn] graphql 部分失败：{msg}", file=sys.stderr)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=str(DATA))
    ap.add_argument("--chunk", type=int, default=CHUNK)
    ap.add_argument("--dry-run", action="store_true", help="只打印将查询的项目数，不发请求")
    args = ap.parse_args()

    data_dir = Path(args.data_dir)
    history = load_json(data_dir / "history.json", {}) or {}
    names = [it["full_name"] for it in (history.get("items") or []) if it.get("full_name")]
    if not names:
        print("[warn] history.json 里没有项目，跳过（先跑 scripts/history.py）", file=sys.stderr)
        return 0

    out_path = data_dir / "stars-live.json"
    old = load_json(out_path, {}) or {}
    old_items: dict[str, dict] = old.get("items") or {}

    if args.dry_run:
        print(f"[dry-run] 将刷新 {len(names)} 个项目，分 {(len(names) + args.chunk - 1) // args.chunk} 个请求")
        return 0

    now = datetime.now(CST).isoformat(timespec="seconds")
    fresh: dict[str, dict] = {}
    ok = failed = 0
    chunk = max(1, args.chunk)
    for start in range(0, len(names), chunk):
        batch = names[start:start + chunk]
        got = fetch_chunk(batch)
        for full in batch:
            if full in got:
                fresh[full] = {"stars_live": got[full], "checked_at": now}
                ok += 1
            else:
                failed += 1
                if full in old_items:  # 失败就保留上一次的值，宁可旧不可错
                    fresh[full] = old_items[full]

    if ok == 0:
        print("[warn] 一条都没刷到（网络或 gh 认证问题），不写文件，保留上一版", file=sys.stderr)
        return 0

    payload = {
        "generated_at": now,
        "source": "github graphql stargazerCount（每个请求 40 个别名，按点数计费）",
        "note": "仅提供实时 star 展示，排序仍用 history.json 的上榜快照口径",
        "project_count": len(names),
        "ok": ok,
        "failed": failed,
        "items": dict(sorted(fresh.items())),
    }
    text = json.dumps(payload, ensure_ascii=False, indent=1)
    out_path.write_text(text + "\n", encoding="utf-8")
    print(
        f"[stars] 刷新 {ok}/{len(names)} 个（失败 {failed}）→ {out_path.name} "
        f"({len(text.encode('utf-8')) / 1024:.1f} KB)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
