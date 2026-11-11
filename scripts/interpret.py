#!/usr/bin/env python3
"""为榜单项目生成「中文七段式解读」，落 data/interpretations.json。

设计
----
1. **只处理没解读过的项目**：hash = sha256(description + readme 摘要)，
   内容没变就跳过 —— 不重复计费，跨日/周/月榜共用同一份解读。
2. **README 是主要事实来源**（截断 3000 字），取不到就只用 description 并标记。
3. **失败不致命**：单个项目失败只记 warn，不影响其他项目、不影响页面和日报。
4. **可离线演练**：--dry-run 只组装 prompt 不调 API；--limit 控制本次处理数量。

用法
----
  ./interpret.py                         # 处理所有未解读项目（上限 20）
  ./interpret.py --limit 5               # 本次最多 5 个
  ./interpret.py --period daily          # 只看日榜
  ./interpret.py --force                 # 忽略 hash，全部重算
  ./interpret.py --dry-run --limit 1     # 打印 prompt，不调模型
"""
from __future__ import annotations

import argparse
import base64
import concurrent.futures
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = DATA / "interpretations.json"
CST = timezone(timedelta(hours=8))

README_LIMIT = 3000
DEFAULT_MODEL = "deepseek-v4-pro"
DEFAULT_BASE = "https://api.deepseek.com/v1"
HERMES_CONFIG = Path.home() / ".hermes" / "config.yaml"
HERMES_ENV = Path.home() / ".hermes" / ".env"

SYSTEM = (
    "你是一名资深软件工程师兼技术选型顾问，擅长把开源项目讲成人话。"
    "你的读者是想判断「这东西跟我有没有关系、要不要用」的工程师和产品经理。"
    "严禁营销腔、严禁编造事实：任何从材料里推不出来的信息都不要写。"
    "如果材料不足以下判断，就直说证据不足，不要脑补。"
    "全部输出简体中文；专有名词、命令、包名保留原文。只输出 JSON，不要 markdown 代码块。"
)

FIELDS_DOC = """{
  "one_liner": "一句话读懂，40 字以内，说清它替你解决什么问题",
  "summary": "段落解读，3-5 句，讲清它是什么、怎么做到的、和同类比的新意在哪",
  "audience": ["谁适合关注，3-5 条，每条一个具体角色或场景"],
  "use_cases": ["能用在哪些具体工作中，3-5 条，要具体到动作"],
  "adoption_steps": ["建议怎么落地，3 条，按先后顺序，能直接照做"],
  "build_ideas": ["可以基于它开发什么，3-5 条，偏二次开发/扩展方向"],
  "risks": ["采用前要确认，3-5 条，真实风险：成熟度/维护状态/许可/依赖/迁移成本"]
}"""


# ── 环境 ──────────────────────────────────────────────────────────────────
def read_hermes_model() -> tuple[str, str]:
    """从 ~/.hermes/config.yaml 读 (base_url, model)，读不到就用官方默认。

    Hermes 常用自建 OpenAI 兼容中转（如 http://172.16.x.x:3000/v1），
    此时 DEEPSEEK_API_KEY 只对那个中转有效，直接打 api.deepseek.com 会 401。
    """
    base, model = DEFAULT_BASE, DEFAULT_MODEL
    if not HERMES_CONFIG.exists():
        return base, model
    text = ""
    try:
        text = HERMES_CONFIG.read_text(encoding="utf-8")
    except OSError:
        return base, model

    try:
        import yaml  # PyYAML 若可用就走正规解析

        cfg = yaml.safe_load(text) or {}
        m = cfg.get("model") or {}
        base = (m.get("base_url") or base).rstrip("/")
        model = m.get("default") or model
        return base, model
    except (ImportError, ValueError):
        pass

    # 没有 PyYAML（cron 的裸 python3 常见）时走最小正则，只认 model: 段的前几行
    m = re.search(r"^model:\s*$(.*?)(?=^\S)", text, re.S | re.M)
    block = m.group(1) if m else ""
    bm = re.search(r"^\s+base_url:\s*['\"]?([^'\"\n]+)", block, re.M)
    mm = re.search(r"^\s+default:\s*['\"]?([^'\"\n]+)", block, re.M)
    if bm:
        base = bm.group(1).strip().rstrip("/")
    if mm:
        model = mm.group(1).strip()
    return base, model


def load_api_key() -> str:
    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if key:
        return key
    for env_path in (HERMES_ENV, ROOT / ".env"):
        if not env_path.exists():
            continue
        for line in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if line.startswith("DEEPSEEK_API_KEY"):
                _, _, val = line.partition("=")
                return val.strip().strip("'\"")
    raise SystemExit("ERROR: 找不到 DEEPSEEK_API_KEY（env 或 ~/.hermes/.env）")


# ── 数据来源 ──────────────────────────────────────────────────────────────
def collect_items(period: str) -> dict[str, dict]:
    """从 latest-*.json 汇总待解读项目（按 full_name 去重，保留排名最靠前的一条）。"""
    periods = ["daily", "weekly", "monthly"] if period == "all" else [period]
    items: dict[str, dict] = {}
    for p in periods:
        f = DATA / f"latest-{p}.json"
        if not f.exists():
            continue
        payload = json.loads(f.read_text(encoding="utf-8"))
        for it in payload.get("items", []):
            name = it.get("full_name")
            if not name:
                continue
            prev = items.get(name)
            if prev is None or it.get("rank", 999) < prev.get("rank", 999):
                items[name] = {**it, "periods": sorted(set(prev["periods"] + [p])) if prev else [p]}
    return items


def gh_bin() -> str:
    """定位 gh：cron 的 `env -i` PATH 里通常没有 ~/.local/bin，必须自己找。"""
    found = shutil.which("gh")
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


def fetch_readme(full_name: str, timeout: int = 25) -> str:
    """gh api 取 README（已登录，5000 req/h）。取不到返回空串。"""
    try:
        proc = subprocess.run(
            [GH, "api", f"repos/{full_name}/readme", "--jq", ".content"],
            capture_output=True, text=True, timeout=timeout,
        )
        if proc.returncode != 0:
            return ""
        raw = base64.b64decode(proc.stdout.strip() + "==").decode("utf-8", "ignore")
        raw = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", raw)          # 图片
        raw = re.sub(r"<img[^>]*>", "", raw)                     # html 图片
        raw = re.sub(r"\n{3,}", "\n\n", raw)
        return raw[:README_LIMIT].strip()
    except (subprocess.SubprocessError, ValueError, OSError):
        return ""


def content_hash(item: dict, readme: str) -> str:
    payload = "\x1f".join([
        item.get("full_name", ""),
        item.get("description", "") or "",
        item.get("language", "") or "",
        readme or "",
    ])
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


# ── 模型调用 ──────────────────────────────────────────────────────────────
def build_prompt(item: dict, readme: str) -> list[dict]:
    body = [
        f"项目：{item['full_name']}",
        f"主语言：{item.get('language') or '未知'}",
        f"累计 star：{item.get('stars_total')}（本期新增 {item.get('stars_period')}）",
        f"出现在榜单：{' / '.join(item.get('periods', []))}",
        f"GitHub 原始描述：{item.get('description') or '（无）'}",
    ]
    if readme:
        body.append("\nREADME 节选（可能被截断）：\n" + readme)
    else:
        body.append("\n（未取到 README，只能依据上面的描述判断；信息不足时请在 risks 里明确说明）")

    user = "\n".join(body) + (
        "\n\n请根据以上材料输出这份 JSON：\n" + FIELDS_DOC +
        "\n\n要求：\n"
        "1. 每条数组元素都是完整的一句话，不要只写关键词。\n"
        "2. adoption_steps 必须可执行（含安装/试用的具体动作或路径）。\n"
        "3. risks 只写真实可验证的风险，不要写「需要持续关注」这类空话。\n"
        "4. 不要出现「本项目」「该仓库」以外的自我指代，不要写「作为一个AI」。\n"
        "5. 只输出 JSON 对象，键必须与上面完全一致。"
    )
    return [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}]


def call_llm(messages: list[dict], model: str, api_key: str,
             base_url: str = DEFAULT_BASE, timeout: int = 180) -> dict:
    payload = json.dumps({
        "model": model,
        "messages": messages,
        "temperature": 0.3,
        "max_tokens": 3000,
        "response_format": {"type": "json_object"},
    }).encode("utf-8")
    req = urllib.request.Request(
        base_url.rstrip("/") + "/chat/completions", data=payload,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = json.loads(resp.read().decode("utf-8", "ignore"))
    content = raw["choices"][0]["message"].get("content") or ""
    if not content.strip():
        raise ValueError("模型返回空内容（可能 max_tokens 被 reasoning 吃光）")
    data = normalize(json.loads(content), raw.get("usage", {}))
    data["model_resolved"] = raw.get("model")
    return data


LIST_FIELDS = ("audience", "use_cases", "adoption_steps", "build_ideas", "risks")


def normalize(data: dict, usage: dict) -> dict:
    """把模型输出规整成固定结构（缺字段补空、类型不对就丢）。"""
    out: dict = {}
    out["one_liner"] = str(data.get("one_liner", "")).strip()[:120]
    out["summary"] = str(data.get("summary", "")).strip()
    for k in LIST_FIELDS:
        v = data.get(k)
        if isinstance(v, str):
            v = [s.strip() for s in re.split(r"[\n；;]+", v) if s.strip()]
        if not isinstance(v, list):
            v = []
        out[k] = [str(x).strip() for x in v if str(x).strip()][:8]
    out["tokens"] = {k: usage.get(k) for k in ("prompt_tokens", "completion_tokens")}
    return out


# ── main ──────────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--period", default="all", choices=["all", "daily", "weekly", "monthly"])
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--model", default=os.environ.get("INTERPRET_MODEL") or None)
    ap.add_argument("--api-base", default=os.environ.get("INTERPRET_API_BASE") or None)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--sleep", type=float, default=1.0, help="每次调用之间的间隔秒数")
    ap.add_argument("--workers", type=int, default=4, help="并发数（I/O 密集，4-6 合适）")
    args = ap.parse_args()

    cfg_base, cfg_model = read_hermes_model()
    model = args.model or cfg_model
    api_base = args.api_base or cfg_base

    items = collect_items(args.period)
    if not items:
        print("没有可解读的项目（latest-*.json 为空？）", file=sys.stderr)
        return 0

    store: dict[str, dict] = {}
    if OUT.exists():
        try:
            store = json.loads(OUT.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print("[warn] interpretations.json 解析失败，将重建", file=sys.stderr)

    api_key = "" if args.dry_run else load_api_key()
    todo: list[tuple[str, dict]] = []
    for name, item in items.items():
        readme = fetch_readme(name) if not args.dry_run else ""
        h = content_hash(item, readme)
        old = store.get(name)
        if not args.force and old and old.get("hash") == h:
            continue
        todo.append((name, {**item, "_readme": readme, "_hash": h}))

    print(
        f"共 {len(items)} 个项目，已有 {len(items) - len(todo)} 份可复用，本次处理 {min(len(todo), args.limit)} 个"
        f"（模型 {model} @ {api_base}）",
        file=sys.stderr,
    )

    counters = {"ok": 0, "fail": 0}
    lock = threading.Lock()

    def save() -> None:
        """每成功一个就落盘：中途被打断也不丢已完成的解读。调用方需持锁。"""
        OUT.write_text(
            json.dumps(dict(sorted(store.items())), ensure_ascii=False, indent=1),
            encoding="utf-8",
        )

    def process(item: dict) -> None:
        name = item["full_name"]
        readme = item["_readme"]
        messages = build_prompt(item, readme)
        try:
            result = call_llm(messages, model, api_key, api_base)
            if not result["one_liner"] and not result["summary"]:
                raise ValueError("模型返回内容为空")
            result.update({
                "hash": item["_hash"],
                "model": model,
                "generated_at": datetime.now(CST).isoformat(timespec="seconds"),
                "readme_used": bool(readme),
                "source_description": item.get("description") or "",
                "language": item.get("language"),
                "url": item.get("url"),
            })
            with lock:
                store[name] = result
                save()
                counters["ok"] += 1
            print(f"  ✓ {name}", file=sys.stderr)
        except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError,
                KeyError, ValueError, TimeoutError, OSError) as e:
            with lock:
                counters["fail"] += 1
            print(f"  ✗ {name}: {type(e).__name__}: {str(e)[:160]}", file=sys.stderr)
        time.sleep(args.sleep)

    batch = todo[: args.limit]

    if args.dry_run:
        for name, item in batch:
            messages = build_prompt(item, item["_readme"])
            print(f"\n===== {name} (readme {len(item['_readme'])} 字) =====")
            print(messages[1]["content"][:1200])
        print(f"\n[dry-run] 共 {len(batch)} 个，未调模型、未写文件", file=sys.stderr)
        return 0

    workers = max(1, min(args.workers, len(batch) or 1))
    if workers == 1:
        for _, item in batch:
            process(item)
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            list(pool.map(process, [item for _, item in batch]))

    ok, fail = counters["ok"], counters["fail"]
    OUT.write_text(
        json.dumps(dict(sorted(store.items())), ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    total_tokens = sum(
        (v.get("tokens") or {}).get("completion_tokens") or 0 for v in store.values()
    )
    print(
        f"✓ 解读完成：新增 {ok}，失败 {fail}，累计 {len(store)} 份"
        f"（累计输出 {total_tokens} tokens）→ {OUT.relative_to(ROOT)}",
        file=sys.stderr,
    )
    return 0  # 失败也算中性退出，不阻断日报与发布


if __name__ == "__main__":
    raise SystemExit(main())
