#!/usr/bin/env python3
"""全部上榜项目的累计视图 → data/history.json（纯统计，不调模型）。

口径（2026-11-12 与用户确认）
----------------------------
- 范围：**所有**日/周/月快照里出现过的项目去重并集（无限窗口，随归档增长）。
- 排名：按**累计 star 总量**降序（stars_total 取该项目最近一次上榜记录的值）。
  注意这不是 GitHub Trending 的口径（trending 按周期内新增 star），
  所以本视图的序号是「体量榜」，与榜单里的 #N 不是一回事。
- 同分兜底：上榜次数多者优先，再按名字。

数据源只用 archive.py 已经维护好的 data/repos.json（含每个项目的 history 数组），
所以本脚本零网络请求，也不重算快照。
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CST = timezone(timedelta(hours=8))
PERIODS = ("daily", "weekly", "monthly")
PERIOD_LABEL = {"daily": "日榜", "weekly": "周榜", "monthly": "月榜"}


def load_json(path: Path, default=None):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default


def build_history() -> dict:
    repos = load_json(DATA / "repos.json", {}) or {}
    rows = []
    for name, rec in repos.items():
        history = rec.get("history") or []
        if not history:
            continue
        # 最近一次上榜的记录（同一天跨榜时取 star 更多的那条，通常是后抓的）
        latest = max(history, key=lambda h: (h.get("date") or "", h.get("stars_total") or 0))
        periods = rec.get("periods") or {}
        rows.append({
            "full_name": name,
            "url": rec.get("url") or f"https://github.com/{name}",
            "description": rec.get("description") or "",
            "language": rec.get("language") or "-",
            "stars_total": latest.get("stars_total") or 0,
            "stars_total_date": latest.get("date"),
            "stars_period_sum": sum(h.get("stars_period") or 0 for h in history),
            "appearances": len(history),
            "best_rank": min((h.get("rank") for h in history if h.get("rank")), default=None),
            "periods": [p for p in PERIODS if p in periods],
            "period_labels": [PERIOD_LABEL[p] for p in PERIODS if p in periods],
            "times_by_period": {p: (periods[p] or {}).get("times", 0) for p in PERIODS if p in periods},
            "first_seen": rec.get("first_seen"),
            "last_seen": rec.get("last_seen"),
        })

    rows.sort(key=lambda r: (-r["stars_total"], -r["appearances"], r["full_name"]))
    for i, r in enumerate(rows, 1):
        r["place"] = i

    snapshots = []
    for p in PERIODS:
        for f in sorted((DATA / str(datetime.now(CST).year)).glob(f"*-{p}.json")):
            payload = load_json(f, {}) or {}
            snapshots.append({"date": payload.get("date") or f.stem.rsplit("-", 1)[0], "period": p})

    dates = sorted({s["date"] for s in snapshots})
    cross = sum(1 for r in rows if len(r["periods"]) > 1)
    return {
        "generated_at": datetime.now(CST).isoformat(timespec="seconds"),
        "basis": "所有日/周/月快照里出现过的项目去重并集，按累计 star 总量降序（取最近一次上榜时的值）",
        "sort_key": "stars_total",
        "project_count": len(rows),
        "index_rows": sum(r["appearances"] for r in rows),
        "snapshot_count": len(snapshots),
        "first_date": dates[0] if dates else None,
        "latest_date": dates[-1] if dates else None,
        "period_counts": {p: sum(1 for s in snapshots if s["period"] == p) for p in PERIODS},
        "cross_board_count": cross,
        "items": rows,
    }


def main() -> int:
    global DATA
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=str(DATA))
    args = ap.parse_args()
    DATA = Path(args.data_dir)
    payload = build_history()
    out = DATA / "history.json"
    text = json.dumps(payload, ensure_ascii=False, indent=1)
    out.write_text(text + "\n", encoding="utf-8")
    print(f"[history] {payload['project_count']} 个项目 / {payload['index_rows']} 条上榜记录"
          f" → {out} ({len(text.encode('utf-8')) / 1024:.1f} KB)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
