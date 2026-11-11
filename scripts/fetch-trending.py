#!/usr/bin/env python3
"""抓取 https://github.com/trending 并输出结构化数据。

用法:  github-trending.py [daily|weekly|monthly] [语言,可选]
输出:  每行一个仓库，制表符分隔:
       rank \t full_name \t stars_today \t total_stars \t language \t url \t description

健壮性说明：
- GitHub 在 WSL/无 TTY 环境下偶发 chunked 传输中断（http.client.IncompleteRead），
  因此优先用 curl（--compressed --retry），失败再退回 urllib，整体最多重试 3 轮。
"""
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request

PERIOD = sys.argv[1] if len(sys.argv) > 1 else "daily"
LANG = sys.argv[2] if len(sys.argv) > 2 else ""

URL = "https://github.com/trending"
if LANG:
    URL += "/" + urllib.parse.quote(LANG)
URL += f"?since={PERIOD}"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


def fetch_curl() -> str:
    """curl 更宽容于服务器提前关闭连接，且 --retry 处理瞬时故障。

    -4 强制 IPv4：WSL 下 github.com 的 AAAA/映射地址偶发黑洞，走 IPv4 最稳。
    超时收得很紧（connect 8s / total 25s），避免一次网络抽风把 cron 拖到 5 分钟。
    """
    out = subprocess.run(
        [
            "curl", "-4", "-sS", "--compressed",
            "--connect-timeout", "8", "-m", "25",
            "--retry", "2", "--retry-all-errors", "--retry-delay", "2",
            "--retry-connrefused",
            "-A", UA, "-H", "Accept-Language: en-US,en;q=0.9",
            URL,
        ],
        capture_output=True,
        timeout=100,
    )
    if out.returncode != 0:
        raise RuntimeError(f"curl exit {out.returncode}: {out.stderr.decode('utf-8', 'ignore')[:200]}")
    text = out.stdout.decode("utf-8", "ignore")
    if "Box-row" not in text:
        raise RuntimeError(f"curl returned {len(text)} bytes without Box-row")
    return text


def fetch_urllib() -> str:
    req = urllib.request.Request(
        URL, headers={"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"}
    )
    text = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "ignore")
    if "Box-row" not in text:
        raise RuntimeError(f"urllib returned {len(text)} bytes without Box-row")
    return text


def parse(html: str):
    articles = re.split(r'<article[^>]*class="[^"]*Box-row', html)[1:]
    rows = []
    for a in articles:
        m = re.search(r'<h2[^>]*>.*?<a[^>]*href="/([^"]+)"', a, re.S)
        if not m:
            continue
        full_name = m.group(1).strip()

        d = re.search(r'<p[^>]*class="[^"]*col-9[^"]*"[^>]*>(.*?)</p>', a, re.S)
        desc = strip_tags(d.group(1)) if d else ""

        lang = re.search(r'<span[^>]*itemprop="programmingLanguage"[^>]*>(.*?)</span>', a, re.S)
        lang = strip_tags(lang.group(1)) if lang else "-"

        st = re.search(r'([\d,]+)\s+stars?\s+(today|this week|this month)', a)
        stars_today = st.group(1).replace(",", "") if st else "?"

        total = re.search(r'href="/[^"]+/stargazers"[^>]*>\s*(?:<[^>]+>\s*)*([\d,]+)', a)
        total_stars = total.group(1).replace(",", "") if total else "?"

        rows.append(
            (full_name, stars_today, total_stars, lang,
             f"https://github.com/{full_name}", desc)
        )
    return rows


def strip_tags(s: str) -> str:
    s = re.sub(r"<[^>]+>", "", s)
    s = (s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
          .replace("&quot;", '"').replace("&#39;", "'").replace("&nbsp;", " "))
    return re.sub(r"\s+", " ", s).strip()


html = None
last_err = None
for attempt in range(1, 3):
    for name, fn in (("curl", fetch_curl), ("urllib", fetch_urllib)):
        try:
            html = fn()
            break
        except Exception as e:  # noqa: BLE001 - 逐层降级
            last_err = f"{name}: {e}"
            print(f"[warn] attempt {attempt} {last_err}", file=sys.stderr)
    if html:
        break
    time.sleep(2 * attempt)

if not html:
    print(f"ERROR: failed to fetch {URL} after retries — {last_err}", file=sys.stderr)
    sys.exit(1)

rows = parse(html)
if not rows:
    print(f"ERROR: parsed 0 repositories from {len(html)} bytes", file=sys.stderr)
    sys.exit(1)


def num(v):
    try:
        return int(v)
    except Exception:
        return -1


rows.sort(key=lambda r: num(r[1]), reverse=True)
for i, r in enumerate(rows, 1):
    print("\t".join([str(i)] + list(r)))
