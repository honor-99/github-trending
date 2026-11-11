#!/usr/bin/env python3
"""GitHub Trending 快照归档器（P1 + P2 派生信号）。

设计原则
--------
1. **快照不可变**：每期落一份 data/YYYY/YYYY-MM-DD-{period}.json，是唯一事实来源。
2. **派生物可重建**：index.jsonl / repos.json / latest-{period}.json 全部由快照
   重新计算得出 —— 所以重复运行天然幂等，不会产生重复行，也不会算错 streak。
3. **离线可测**：--from-tsv / --data-dir 让你用固定数据在临时目录里验证逻辑。

用法
----
  ./archive.py --period daily               # 抓取 + 归档 + 重建派生
  ./archive.py --period weekly
  ./archive.py --period monthly
  ./archive.py --period daily --from-tsv /tmp/rows.tsv --data-dir /tmp/tdata

输出（stdout）: 一行人类可读摘要；详细数据在 JSON 里。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

CST = timezone(timedelta(hours=8))
ROOT = Path(__file__).resolve().parent.parent
FETCHER = Path(__file__).resolve().parent / "fetch-trending.py"

PERIOD_LABEL = {"daily": "日榜", "weekly": "周榜", "monthly": "月榜"}
PERIOD_SOURCE = {
    "daily": "https://github.com/trending?since=daily",
    "weekly": "https://github.com/trending?since=weekly",
    "monthly": "https://github.com/trending?since=monthly",
}


# ── 抓取 ──────────────────────────────────────────────────────────────────
def fetch_tsv(period: str, lang: str) -> str:
    cmd = [sys.executable, str(FETCHER), period]
    if lang:
        cmd.append(lang)
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr[-800:])
        raise SystemExit(f"ERROR: fetch-trending.py exited {proc.returncode}")
    return proc.stdout


def parse_tsv(text: str) -> list[dict]:
    items: list[dict] = []
    for line in text.splitlines():
        line = line.rstrip("\n")
        if not line.strip():
            continue
        cols = line.split("\t")
        if len(cols) < 7:
            continue
        rank, full_name, stars_period, stars_total, lang, url, desc = cols[:7]
        try:
            rank_i = int(rank)
        except ValueError:
            continue
        items.append(
            {
                "rank": rank_i,
                "full_name": full_name.strip(),
                "stars_period": to_int(stars_period),
                "stars_total": to_int(stars_total),
                "language": lang.strip() or "-",
                "url": url.strip(),
                "description": desc.strip(),
            }
        )
    items.sort(key=lambda r: r["rank"])
    return items


def to_int(v: str) -> int | None:
    try:
        return int(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return None


# ── 快照 IO ───────────────────────────────────────────────────────────────
def snap_dir(data_dir: Path, d: str) -> Path:
    return data_dir / d[:4]


def snap_path(data_dir: Path, d: str, period: str, lang: str = "") -> Path:
    suffix = f"-{slug(lang)}" if lang else ""
    return snap_dir(data_dir, d) / f"{d}-{period}{suffix}.json"


def slug(s: str) -> str:
    return "".join(c if c.isalnum() else "-" for c in s.lower()).strip("-")


def load_snapshots(data_dir: Path, period: str, lang: str = "") -> list[dict]:
    out: list[dict] = []
    suffix = f"-{period}{('-' + slug(lang)) if lang else ''}.json"
    for f in sorted(data_dir.glob(f"[0-9][0-9][0-9][0-9]/*{suffix}")):
        try:
            out.append(json.loads(f.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError) as e:  # 坏文件不阻断重建
            sys.stderr.write(f"[warn] skip {f.name}: {e}\n")
    out.sort(key=lambda s: s["date"])
    return out


# ── 派生：信号与 streak ───────────────────────────────────────────────────
def compute_signals(cur: dict, prev: dict | None) -> tuple[list[dict], list[dict]]:
    """返回 (items_with_status, dropped)。

    status: new（新上榜）/ continued（持续热门）/ -
    streak: 连续在榜次数（含本次）
    """
    items = [dict(i) for i in cur["items"]]
    prev_names = {i["full_name"] for i in prev["items"]} if prev else set()
    prev_rank = {i["full_name"]: i["rank"] for i in prev["items"]} if prev else {}

    for it in items:
        it["status"] = "continued" if it["full_name"] in prev_names else "new"
        it["prev_rank"] = prev_rank.get(it["full_name"])
        it["rank_change"] = (
            it["prev_rank"] - it["rank"] if it.get("prev_rank") else None
        )

    cur_names = {i["full_name"] for i in items}
    dropped = [
        {
            "full_name": i["full_name"],
            "last_rank": i["rank"],
            "last_stars_total": i.get("stars_total"),
            "language": i.get("language"),
            "url": i.get("url"),
        }
        for i in prev["items"]
        if i["full_name"] not in cur_names
    ] if prev else []
    return items, dropped


def apply_streaks(snapshots: list[dict]) -> list[dict]:
    """按时间顺序给每个快照的 items 打上 streak（该期连续在榜次数）。"""
    streak: dict[str, int] = {}
    enriched: list[dict] = []
    for snap in snapshots:
        names_now = set()
        for it in snap["items"]:
            name = it["full_name"]
            names_now.add(name)
            streak[name] = streak.get(name, 0) + 1
            it["streak"] = streak[name]
        for name in list(streak):
            if name not in names_now:  # 掉榜即清零
                del streak[name]
        enriched.append(snap)
    return enriched


# ── 派生：repos 维表 + 总账 + latest ──────────────────────────────────────
def rebuild(periods: list[str], data_dir: Path, langs: dict[str, str]) -> dict:
    repos: dict[str, dict] = {}
    index_rows: list[dict] = []
    latest: dict[str, dict] = {}

    for period in periods:
        lang = langs.get(period, "")
        snaps = apply_streaks(load_snapshots(data_dir, period, lang))
        if not snaps:
            continue

        seen_dates: list[str] = []
        for snap in snaps:
            seen_dates.append(snap["date"])
            for it in snap["items"]:
                rec = repos.setdefault(
                    it["full_name"],
                    {
                        "full_name": it["full_name"],
                        "url": it.get("url"),
                        "language": it.get("language"),
                        "description": it.get("description"),
                        "first_seen": snap["date"],
                        "last_seen": snap["date"],
                        "times_on_board": 0,
                        "periods": {},
                        "history": [],
                    },
                )
                rec["url"] = it.get("url") or rec["url"]
                rec["language"] = it.get("language") or rec["language"]
                rec["description"] = it.get("description") or rec["description"]
                rec["last_seen"] = snap["date"]
                rec["times_on_board"] += 1
                p = rec["periods"].setdefault(
                    period, {"times": 0, "streak": 0, "last_date": None}
                )
                p["times"] += 1
                p["streak"] = it["streak"]
                p["last_date"] = snap["date"]
                rec["history"].append(
                    {
                        "date": snap["date"],
                        "period": period,
                        "rank": it["rank"],
                        "stars_total": it.get("stars_total"),
                        "stars_period": it.get("stars_period"),
                    }
                )
                index_rows.append(
                    {
                        "date": snap["date"],
                        "period": period,
                        "rank": it["rank"],
                        "full_name": it["full_name"],
                        "stars_period": it.get("stars_period"),
                        "stars_total": it.get("stars_total"),
                        "language": it.get("language"),
                        "status": it.get("status"),
                        "streak": it["streak"],
                        "url": it.get("url"),
                    }
                )

        # latest：最后一期快照 + 与上一期的信号
        cur = snaps[-1]
        prev = snaps[-2] if len(snaps) > 1 else None
        items, dropped = compute_signals(cur, prev)
        latest[period] = {
            "period": period,
            "label": PERIOD_LABEL[period],
            "date": cur["date"],
            "prev_date": prev["date"] if prev else None,
            "fetched_at": cur.get("fetched_at"),
            "source": cur.get("source"),
            "count": len(items),
            "signals": {
                "total": len(items),
                "new": sum(1 for i in items if i["status"] == "new"),
                "continued": sum(1 for i in items if i["status"] == "continued"),
                "dropped": len(dropped),
            },
            "items": items,
            "dropped": dropped,
            "snapshot_count": len(snaps),
            "first_snapshot": seen_dates[0] if seen_dates else None,
        }

    (data_dir / "repos.json").write_text(
        json.dumps(repos, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8"
    )
    with (data_dir / "index.jsonl").open("w", encoding="utf-8") as fh:
        for row in index_rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    for period, payload in latest.items():
        (data_dir / f"latest-{period}.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8"
        )
    (data_dir / "meta.json").write_text(
        json.dumps(
            {
                "generated_at": datetime.now(CST).isoformat(timespec="seconds"),
                "periods": latest,
                "repo_count": len(repos),
                "index_rows": len(index_rows),
            },
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )
    return {"latest": latest, "repo_count": len(repos), "index_rows": len(index_rows)}


# ── main ──────────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--period", default="daily", choices=list(PERIOD_LABEL))
    ap.add_argument("--lang", default="", help="语言过滤，如 python / rust")
    ap.add_argument("--date", default=datetime.now(CST).date().isoformat())
    ap.add_argument("--from-tsv", default=None)
    ap.add_argument("--data-dir", default=str(ROOT / "data"))
    ap.add_argument("--no-rebuild", action="store_true")
    args = ap.parse_args()

    data_dir = Path(args.data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)

    if args.from_tsv:
        tsv = Path(args.from_tsv).read_text(encoding="utf-8")
    elif args.from_tsv == "-":
        tsv = sys.stdin.read()
    else:
        tsv = fetch_tsv(args.period, args.lang)

    items = parse_tsv(tsv)
    if not items:
        print("ERROR: parsed 0 rows", file=sys.stderr)
        return 1

    now = datetime.now(CST).isoformat(timespec="seconds")
    snapshot = {
        "period": args.period,
        "lang": args.lang or None,
        "date": args.date,
        "fetched_at": now,
        "source": PERIOD_SOURCE[args.period]
        + (f"/{args.lang}" if args.lang else ""),
        "count": len(items),
        "items": items,
    }
    path = snap_path(data_dir, args.date, args.period, args.lang)
    path.parent.mkdir(parents=True, exist_ok=True)
    prev_existed = path.exists()
    path.write_text(
        json.dumps(snapshot, ensure_ascii=False, indent=1), encoding="utf-8"
    )

    if args.no_rebuild:
        print(f"✓ snapshot {path.relative_to(data_dir)} ({len(items)} 条，未重建派生)")
        return 0

    periods = sorted(PERIOD_LABEL)
    info = rebuild(periods, data_dir, {p: (args.lang if p == args.period else "") for p in periods})
    lat = info["latest"].get(args.period, {})
    sig = lat.get("signals", {})
    print(
        f"✓ {PERIOD_LABEL[args.period]} {args.date}: {len(items)} 条"
        f"（{'覆盖' if prev_existed else '新增'}快照）"
        f" | 新上榜 {sig.get('new', '?')} · 持续 {sig.get('continued', '?')}"
        f" · 掉榜 {sig.get('dropped', '?')} | 累计 {info['repo_count']} 个仓库"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
