#!/usr/bin/env python3
"""从已有快照派生三类「看法」，全部纯统计，不调任何模型。

产物（都写在 data/ 下，前端直接 fetch）：
  topics.json     P1 趋势话题聚合：把项目按关键词规则归到话题，看哪个方向在冒头
  potential.json  P2 潜力观察：排除头部与噪音，按「增速 × 体量 × 新鲜度」给可解释的分
  archive.json    数据说明页：快照清单、体量、字段文档（替代直接打开 meta.json 原始 JSON）

设计原则
--------
- 快照是唯一事实来源，这里只读不写快照；每次全量重算，天然幂等。
- 每条结论都要能解释：分项字段 + reasons 文案，不做黑盒评分。
- 规则集中在 TOPIC_RULES / score()，改口径只改这里。
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CST = timezone(timedelta(hours=8))
PERIODS = ("daily", "weekly", "monthly")

# ── 话题规则 ────────────────────────────────────────────────────────────────
# 顺序即优先级；一个项目最多归 3 个话题（跨方向的项目本来就有多个标签）。
TOPIC_RULES: list[tuple[str, list[str]]] = [
    ("AI Agent / 编码助手", [
        "agent", "agents", "mcp", "copilot", "claude", "codex", "cursor",
        "skill", "skills", "prompt", "assistant", "autonomous", "subagent",
    ]),
    ("LLM / 模型与推理", [
        "llm", "gpt", "inference", "vllm", "transformer", "rag", "embedding",
        "fine-tun", "diffusion", "llama", "qwen", "deepseek", "tokeniz",
        "quantiz", "context window", "moe",
    ]),
    ("前端 / 设计系统", [
        "react", "vue", "svelte", "tailwind", "component", "design system",
        "frontend", "nextjs", "astro", "css", "storybook", "figma",
    ]),
    ("后端 / 基础设施", [
        "server", "database", "postgres", "redis", "kafka", "kubernetes",
        "docker", "proxy", "gateway", "backend", "queue", "runtime", "compiler",
    ]),
    ("CLI / 开发者工具", [
        "cli", "terminal", "tui", "shell", "dotfile", "vim", "neovim",
        "editor", "formatter", "linter", "git", "devtool",
    ]),
    ("安全 / 逆向", [
        "security", "vulnerab", "cve", "exploit", "pentest", "malware",
        "reverse", "ghidra", "audit", "privacy", "encrypt", "supply chain",
    ]),
    ("数据 / 爬虫", [
        "scrap", "crawl", "spider", "dataset", "etl", "pipeline", "analytics",
        "pandas", "sql", "scraping",
    ]),
    ("音视频 / 多模态", [
        "video", "audio", "image", "tts", "asr", "speech", "music", "ffmpeg",
        "multimodal", "voice", "camera",
    ]),
    ("自动化 / 效率", [
        "automat", "workflow", "productivity", "note", "task", "calendar",
        "email", "browser", "macro", "shortcut",
    ]),
    ("游戏 / 图形", [
        "game", "graphics", "shader", "webgl", "godot", "unity", "pixel",
        "3d", "raytrac",
    ]),
    ("学习 / 知识管理", [
        "tutor", "learn", "course", "knowledge", "wiki", "book", "research",
        "paper", "flashcard", "study",
    ]),
    ("机器人 / 硬件", [
        "robot", "drone", "embedded", "arduino", "raspberry", "iot", "firmware",
        "mujoco", "simulation",
    ]),
]
OTHER = "其他 / 未归类"


def load_json(path: Path, default=None):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default


def write_json(path: Path, payload) -> int:
    text = json.dumps(payload, ensure_ascii=False, indent=1)
    path.write_text(text + "\n", encoding="utf-8")
    return len(text.encode("utf-8"))


def latest_items() -> dict[str, dict]:
    """跨周期去重的最新项目表（同名项目保留排名最靠前的那条，并合并 periods）。"""
    merged: dict[str, dict] = {}
    for p in PERIODS:
        payload = load_json(DATA / f"latest-{p}.json", {}) or {}
        for it in payload.get("items", []):
            name = it.get("full_name")
            if not name:
                continue
            cur = merged.get(name)
            if cur is None:
                merged[name] = {**it, "periods": [p]}
                continue
            cur["periods"] = sorted(set(cur["periods"] + [p]))
            if it.get("rank", 999) < cur.get("rank", 999):
                keep_periods = cur["periods"]
                merged[name] = {**it, "periods": keep_periods}
    return merged


# ── P1 话题聚合 ─────────────────────────────────────────────────────────────
def classify(text: str) -> list[str]:
    hay = text.lower()
    hits = []
    for topic, words in TOPIC_RULES:
        for w in words:
            if re.search(rf"(?<![a-z0-9]){re.escape(w)}", hay):
                hits.append(topic)
                break
        if len(hits) >= 3:
            break
    return hits or [OTHER]


def build_topics(items: dict[str, dict]) -> dict:
    buckets: dict[str, list[dict]] = {t: [] for t, _ in TOPIC_RULES}
    buckets[OTHER] = []

    for name, it in items.items():
        text = f"{name} {it.get('description') or ''}"
        for topic in classify(text):
            buckets.setdefault(topic, []).append(it)

    topics = []
    total = len(items) or 1
    for topic, rows in buckets.items():
        if not rows or (topic == OTHER and len(rows) == len(items)):
            continue
        rows = sorted(rows, key=lambda r: r.get("stars_period") or 0, reverse=True)
        stars = sum(r.get("stars_period") or 0 for r in rows)
        topics.append({
            "name": topic,
            "repo_count": len(rows),
            "share": round(len(rows) / total, 3),
            "stars_period_total": stars,
            "avg_stars_period": round(stars / len(rows)),
            "languages": sorted({r.get("language") or "?" for r in rows})[:6],
            "repos": [
                {
                    "full_name": r["full_name"],
                    "stars_period": r.get("stars_period"),
                    "stars_total": r.get("stars_total"),
                    "language": r.get("language"),
                    "periods": r.get("periods"),
                }
                for r in rows[:5]
            ],
        })

    topics.sort(key=lambda t: (t["repo_count"], t["stars_period_total"]), reverse=True)
    return {
        "generated_at": datetime.now(CST).isoformat(timespec="seconds"),
        "basis": "最近一次日/周/月榜去重后的项目，按名称+描述关键词规则归类（最多 3 个话题）",
        "project_count": len(items),
        "topics": topics,
    }


# ── P2 潜力观察 ─────────────────────────────────────────────────────────────
HEAD_LIMIT = 150_000   # 超过这个 star 体量视为「头部」，不进潜力榜
MIN_GAIN = 200         # 本期新增低于此值视为噪音


def potential_score(it: dict) -> dict | None:
    gain = it.get("stars_period") or 0
    total = it.get("stars_total") or 0
    if gain < MIN_GAIN or total <= 0 or total > HEAD_LIMIT:
        return None

    growth = gain / max(total - gain, 1)          # 本期涨幅（相对存量）
    headroom = 1 - min(total / HEAD_LIMIT, 0.85)  # 体量越大空间越小（最少留 15% 权重）
    volume = min(math.log10(max(gain, 1)) / 4, 1)  # 绝对增量（1万/期 记满分）
    streak = it.get("streak") or 1
    stability = min(streak / 3, 1) * 0.15
    fresh = 1.15 if (it.get("times_on_board") or 1) <= 1 else 1.0

    score = 100 * headroom * fresh * (0.5 * min(growth / 0.25, 1) + 0.35 * volume + stability)
    score = round(min(score, 100), 1)

    reasons = [f"本期 +{gain:,} star，相当于存量的 {growth:.1%}"]
    if fresh > 1:
        reasons.append("刚进榜单，还没被反复曝光")
    if total < 30_000:
        reasons.append(f"体量仅 {total:,} star，向上空间大")
    if streak >= 2:
        reasons.append(f"连续 {streak} 期在榜，热度不是一次性")
    if gain >= 2000:
        reasons.append("单期绝对增量超过 2,000，属于爆发型")

    return {
        "full_name": it["full_name"],
        "score": score,
        "stars_period": gain,
        "stars_total": total,
        "growth": round(growth, 4),
        "language": it.get("language"),
        "description": it.get("description"),
        "periods": it.get("periods"),
        "streak": streak,
        "reasons": reasons,
    }


def build_potential(items: dict[str, dict], limit: int = 8) -> dict:
    scored = [s for s in (potential_score(it) for it in items.values()) if s]
    scored.sort(key=lambda s: s["score"], reverse=True)
    excluded = sum(
        1 for it in items.values()
        if (it.get("stars_total") or 0) > HEAD_LIMIT or (it.get("stars_period") or 0) < MIN_GAIN
    )
    return {
        "generated_at": datetime.now(CST).isoformat(timespec="seconds"),
        "method": (
            "score = 100 × 体量空间 × 新鲜度 × (0.5×涨幅分 + 0.35×增量分 + 0.15×连续在榜分)；"
            f"排除 star > {HEAD_LIMIT:,} 的头部与单期新增 < {MIN_GAIN} 的噪音"
        ),
        "candidate_count": len(scored),
        "excluded_count": excluded,
        "items": scored[:limit],
    }


# ── 数据说明页 ──────────────────────────────────────────────────────────────
FIELDS = [
    ["date / period", "快照日期与周期（daily / weekly / monthly），文件名即 2026-11-11-daily.json"],
    ["rank", "在该期 GitHub Trending 页面上的名次"],
    ["stars_period", "该周期内新增 star（日榜=今日，周榜=本周，月榜=本月）"],
    ["stars_total", "抓取时的累计 star"],
    ["language", "GitHub 标注的主语言，空值为 -"],
    ["description", "GitHub 原始描述，逐字保留不改写"],
    ["status", "派生信号：new 新上榜 / continued 持续在榜 / dropped 掉榜"],
    ["streak", "连续在榜期数，掉榜后清零"],
    ["rank_change", "与上一期相比的名次变化（正数为上升）"],
]


def build_archive() -> dict:
    snapshots = []
    for p in PERIODS:
        for f in sorted((DATA / str(datetime.now(CST).year)).glob(f"*-{p}.json")):
            payload = load_json(f, {}) or {}
            snapshots.append({
                "date": payload.get("date") or f.stem.rsplit("-", 1)[0],
                "period": p,
                "count": payload.get("count") or len(payload.get("items", [])),
                "fetched_at": payload.get("fetched_at"),
                "signals": payload.get("signals"),
                "bytes": f.stat().st_size,
                "path": f"data/{f.parent.name}/{f.name}",
            })
    snapshots.sort(key=lambda s: (s["date"], PERIODS.index(s["period"])), reverse=True)

    repos = load_json(DATA / "repos.json", {}) or {}
    interp = load_json(DATA / "interpretations.json", {}) or {}
    index_rows = 0
    idx = DATA / "index.jsonl"
    if idx.exists():
        index_rows = sum(1 for line in idx.read_text(encoding="utf-8").splitlines() if line.strip())

    dates = sorted({s["date"] for s in snapshots})
    return {
        "generated_at": datetime.now(CST).isoformat(timespec="seconds"),
        "summary": {
            "repo_count": len(repos),
            "index_rows": index_rows,
            "snapshot_count": len(snapshots),
            "interpreted_count": len(interp),
            "first_date": dates[0] if dates else None,
            "latest_date": dates[-1] if dates else None,
            "total_bytes": sum(s["bytes"] for s in snapshots),
        },
        "snapshots": snapshots,
        "fields": [{"field": f, "desc": d} for f, d in FIELDS],
        "files": [
            {"name": "data/index.jsonl", "desc": "总账：一行一条上榜记录，由全部快照重建"},
            {"name": "data/repos.json", "desc": "仓库维表：首次上榜、在榜次数、连续期数、历史"},
            {"name": "data/latest-<period>.json", "desc": "每期最新一期 + 派生信号，页面读这个"},
            {"name": "data/interpretations.json", "desc": "中文七段式解读，按仓库内容 hash 幂等"},
            {"name": "data/topics.json", "desc": "话题聚合结果（本次生成）"},
            {"name": "data/potential.json", "desc": "潜力观察结果（本次生成）"},
        ],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    items = latest_items()
    if not items:
        print("没有 latest-*.json，跳过 insights", file=sys.stderr)
        return 0

    topics = build_topics(items)
    potential = build_potential(items)

    sizes = {
        "topics.json": write_json(DATA / "topics.json", topics),
        "potential.json": write_json(DATA / "potential.json", potential),
        "archive.json": write_json(DATA / "archive.json", build_archive()),
    }
    if not args.quiet:
        top = topics["topics"][:3]
        print(
            f"✓ 话题 {len(topics['topics'])} 个（"
            + " · ".join(f"{t['name'].split(' / ')[0]} {t['repo_count']}" for t in top)
            + f"）| 潜力候选 {potential['candidate_count']} 个 | "
            + ", ".join(f"{k} {v//1024}KB" for k, v in sizes.items()),
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
