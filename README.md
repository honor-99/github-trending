# GitHub 热度追踪（榜单归档 + 信号）

把 GitHub Trending 的每一期榜单存成**不可变快照**，与上一期对比派生出
**新上榜 / 持续热门（连续 N 次）/ 掉榜** 三个信号，用純静态页面展示。

无服务端、无构建、无第三方依赖：`index.html` + `assets/` 就是全部前端，数据是 JSON 文件。

**在线地址**：https://trending.208202.xyz/ （旧路径 `208202.xyz/github-trending/` 301 跳转到这里）

部署方式：GitHub Pages 从 `master` 分支根目录发布（非 Actions 构建），自定义域 `trending.208202.xyz`
（Cloudflare CNAME → `honor-99.github.io`，**DNS only 灰云**；橙云会让 GitHub 签证书失败）。

## 目录结构

```
index.html              页面骨架（纯 HTML）
assets/styles.css       样式（浅色 / 深色自适应，移动端适配）
assets/app.js           渲染逻辑（原生 JS，fetch JSON；含详情抽屉）
scripts/fetch-trending.py   抓 https://github.com/trending → TSV
scripts/archive.py          归档 + 派生（唯一写数据的入口）
scripts/insights.py         纯统计派生：话题聚合 / 潜力观察 / 数据说明（不调模型）
scripts/interpret.py        中文七段式解读（LLM 预生成，按 hash 幂等）
scripts/publish.sh          幂等提交 + 推送
data/
  YYYY/YYYY-MM-DD-<period>.json   每期快照（唯一事实来源，不可变）
  index.jsonl                     总账：一行一条上榜记录（由快照重建）
  repos.json                      仓库维表：first_seen / times_on_board / streak / history
  latest-<period>.json            每期最新一期 + 信号（前端读取这个）
  interpretations.json            仓库 → 中文七段式解读（跨周期共用）
  topics.json                     话题聚合结果（P1）
  potential.json                  潜力观察结果（P2）
  archive.json                    数据说明页：快照清单 + 字段文档（P2 起替代裸 meta.json）
  meta.json                       全局元信息
```

`period` ∈ `daily | weekly | monthly`。

## 设计原则

1. **快照不可变**：一次抓取落一份文件，永不修改历史。
2. **派生物可重建**：`index.jsonl` / `repos.json` / `latest-*.json` 全部从快照重新计算。
   → 重复运行天然幂等，不会重复计行，也不会算错 streak。
3. **无对比基线就不假装有信号**：只有一份快照时，页面明确写"首份快照，持续/掉榜下次才出现"。

## 用法

```bash
# 抓取 + 归档 + 重建派生（正常用法）
python3 scripts/archive.py --period daily
python3 scripts/archive.py --period weekly
python3 scripts/archive.py --period monthly

# 语言过滤榜
python3 scripts/archive.py --period daily --lang python

# 离线回放（用已有 TSV，不联网）
python3 scripts/archive.py --period daily --date 2026-11-11 --from-tsv /tmp/rows.tsv

# 写到别的目录（用来跑测试，不污染 data/）
python3 scripts/archive.py --period daily --data-dir /tmp/tdata --from-tsv /tmp/rows.tsv
```

TSV 格式（`fetch-trending.py` 输出，7 列制表符分隔）：

```
rank  full_name  stars_period  stars_total  language  url  description
```

## 信号是怎么算的

| 信号 | 定义 |
|---|---|
| 新上榜 | 本期出现、上一期（同 period）没有 |
| 持续热门 | 本期与上一期都出现；`streak` = 连续在榜期数（掉榜即清零） |
| 掉榜 | 上一期有、本期没有（附带 last_rank / last_stars_total） |
| rank_change | 上一期名次 − 本期名次（正数=上升）；新项目为 `null` |

## 本地预览

```bash
python3 -m http.server 8123 --bind 127.0.0.1
# 打开 http://127.0.0.1:8123/
# 切换周榜/月榜：http://127.0.0.1:8123/?p=weekly
```

## 中文七段式解读（interpret.py）

点任意条目 → 右侧抽屉渲染：`一句话读懂 / 它是什么 / 谁适合关注 / 能用在哪些工作中 /
建议怎么落地（编号）/ 可以基于它开发什么 / 采用前要确认（风险）/ GitHub 原始描述`。

```bash
python3 scripts/interpret.py --limit 8 --workers 6   # 补一批没解读过的
python3 scripts/interpret.py --dry-run --limit 1     # 只打印 prompt，不调模型
python3 scripts/interpret.py --force --limit 3       # 忽略 hash 强制重算
```

- **输入**：GitHub `README`（`gh api repos/{o}/{r}/readme`，截断 3000 字）+ 描述 + star + 语言。
  33/33 都成功取到 README。
- **幂等**：`hash = sha256(full_name + description + language + readme)`，没变就跳过，跨日/周/月榜共用一份。
- **落盘**：每成功一个立刻写 `interpretations.json`，中途被打断不丢进度。
- **并发**：默认 4，实测 `--workers 6` 时 33 个约 3 分钟（串行约 50 分钟）。
- **模型**：默认读 `~/.hermes/config.yaml` 的 `model.base_url` + `model.default`，
  可用 `--model` / `--api-base` 或环境变量 `INTERPRET_MODEL` / `INTERPRET_API_BASE` 覆盖。
  注意中转可能改写模型：请求 `deepseek-v4-pro`，实际返回 `deepseek-v4.1-flash-1017` / `deepseek-flash`，
  该映射会记录在每条解读的 `model_resolved` 字段并在 UI 里显示。
- **失败降级**：单个项目失败只告警；没有解读的条目在抽屉里显示"还没生成" + 原始描述。

## 派生洞察（insights.py，零模型成本）

```bash
python3 scripts/insights.py     # 秒级，读写都在 data/
```

**P1 趋势话题**：按 `TOPIC_RULES` 关键词规则，把最近一次日/周/月榜的项目归到 12 个方向
（AI Agent / 编码助手、LLM / 模型与推理、前端 / 设计系统、后端 / 基础设施、CLI / 开发者工具、
安全 / 逆向、数据 / 爬虫、音视频 / 多模态、自动化 / 效率、游戏 / 图形、学习 / 知识管理、机器人 / 硬件，
其余进「其他/未归类」）。一个项目最多打 3 个标签。输出每话题的仓库数、占比、本期新增 star、
代表语言与 Top5 项目。改口径只改 `TOPIC_RULES`。

**P2 潜力观察**：找中腰部高增速，而不是重复排行榜本身。

```
score = 100 × 体量空间 × 新鲜度 × (0.5×涨幅分 + 0.35×增量分 + 0.15×连续在榜分)
体量空间 = 1 - min(stars_total / 150000, 0.85)
新鲜度   = 首次上榜 ×1.15
排除：stars_total > 150,000（头部）或本期新增 < 200（噪音）
```

每条都带 `reasons`（可解释文案，如「本期 +9,621 star，相当于存量的 514.5%」），不做黑盒分。

**数据说明**：`archive.json` 汇总快照清单（日期/期/条数/新续掉/大小）、仓库数、上榜记录数、
已解读数、字段文档与文件清单 —— 页面右上「数据」按钮打开的就是它（不再直接甩原始 JSON）。

## 定时任务怎么接

抓取由本机 cron 触发，**不用 GitHub Actions**（Pages 走分支部署）：

```
cron 08:00  →  scripts/archive.py --period daily
            →  scripts/insights.py                                          （秒级，零成本）
            →  scripts/interpret.py --period all --limit 8 --workers 6   （硬超时 150s）
            →  git add data/ && git commit && git push
            →  Pages 从分支发布
```

`archive.py` 的幂等性就是为"重跑 / 补跑 / 兜底跑"准备的：同一天跑几次，数据都一样。

## 已验证

- `scripts/archive.py` 派生逻辑：3 天 fixture 回归（new/continued/dropped/streak/rank_change/维表/幂等）→ ALL PASS
- 页面渲染：日榜信号卡 `4/2/2/1`、三区块条数 `2/2/1`、`连续 3 次` 徽标、日/周/月切换
- 响应式：390×844 无横向溢出；深色模式可读

## 下一阶段（未做）

- 中文七段式解读（一句话读懂 / 谁适合关注 / 建议怎么落地 / 采用前要确认…）——在 cron 里预生成落 JSON，不引入运行时后端
- 趋势话题聚合、潜力分
- 留存 / 灵感库（需要 Workers + KV 或 localStorage）
