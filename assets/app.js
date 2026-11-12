/* GitHub 热度追踪 · 纯静态渲染（无依赖、无构建） */
(() => {
  'use strict';

  const LABEL = {
    daily: '日榜', weekly: '周榜', monthly: '月榜', history: '历史榜单',
    topics: '趋势话题', potential: '潜力观察', github: 'GitHub 总榜',
  };
  const PERIOD_HINT = {
    daily: '今日增长榜', weekly: '本周增长榜', monthly: '本月增长榜',
    history: '全部上榜项目', topics: '本期方向分布', potential: '上升空间观察',
    github: '全部仓库 · 按 star 总数',
  };

  const $ = (sel) => document.querySelector(sel);
  const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('zh-CN'));

  /* ── 外观皮肤：paper（纸感浅色）/ slate（深墨精密） ── */
  const SKINS = { paper: '纸感', slate: '深墨' };
  function applySkin(skin, { persist = true } = {}) {
    const next = SKINS[skin] ? skin : 'paper';
    document.documentElement.dataset.skin = next;
    if (persist) { try { localStorage.setItem('trend.skin', next); } catch (e) { /* 隐私模式 */ } }
    const btn = $('#skinToggle');
    if (btn) {
      btn.textContent = `外观 · ${SKINS[next]}`;
      btn.setAttribute('aria-label', `当前外观 ${SKINS[next]}，点击切换`);
    }
  }
  const LANG_SLUG = (lang) => String(lang || '').toLowerCase().replace(/[^a-z+#]/g, '');
  function langDot(lang) {
    const dot = el('span', 'lang-dot');
    dot.dataset.lang = LANG_SLUG(lang);
    dot.title = lang || '';
    return dot;
  }

  /* 解读库：{ full_name: {...} }，缺失时面板优雅降级 */
  let INTERP = {};
  /* 派生洞察：话题 / 潜力 / 数据说明，缺失时对应区块隐藏 */
  const INSIGHTS = { topics: null, potential: null, archive: null };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  /* 名次标签：#N 是 GitHub Trending 总榜的原始名次，不是列表内序号 —— 用 title/aria 说清楚 */
  function rankTag(rank, scope) {
    const node = el('span', 'rank', `#${rank}`);
    const where = scope === '上期' ? '上一期榜单' : '本期榜单';
    node.title = `GitHub Trending 总榜${scope === '上期' ? '（上一期）' : ''}第 ${rank} 名 —— 这是该项目的原始名次，不是本列表内的序号`;
    node.setAttribute('aria-label', `${where}第 ${rank} 名`);
    return node;
  }

  function currentPeriod() {
    const p = new URLSearchParams(location.search).get('p');
    return LABEL[p] ? p : 'daily';
  }

  /* 分段控件的滑动指示器 */
  function moveIndicator() {
    const bar = document.querySelector('.seg-indicator');
    const active = document.querySelector('.segmented button[aria-selected="true"]');
    if (!bar || !active) return;
    bar.style.width = `${active.offsetWidth}px`;
    bar.style.transform = `translateX(${active.offsetLeft - 2}px)`;
  }

  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function countUp(node, target) {
    const value = Number(target);
    if (REDUCED || !Number.isFinite(value)) { node.textContent = String(target); return; }
    const duration = 620;
    const start = performance.now();
    const tick = (now) => {
      const p = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      node.textContent = String(Math.round(value * eased));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function setPeriod(period, { push = true } = {}) {
    document.querySelectorAll('.segmented button').forEach((b) => {
      b.setAttribute('aria-selected', String(b.dataset.period === period));
    });
    moveIndicator();
    const activeBtn = document.querySelector('.segmented button[aria-selected="true"]');
    if (activeBtn && activeBtn.scrollIntoView) {
      activeBtn.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
    if (push) {
      const url = new URL(location.href);
      if (period === 'daily') url.searchParams.delete('p');
      else url.searchParams.set('p', period);
      history.replaceState(null, '', url);
    }
    load(period);
  }

  async function loadInterpretations() {
    try {
      const res = await fetch('data/interpretations.json', { cache: 'no-store' });
      if (res.ok) INTERP = await res.json();
    } catch (err) {
      INTERP = {}; // 解读库缺失不影响主榜单
    }
  }

  async function fetchJson(name) {
    try {
      const res = await fetch(`data/${name}`, { cache: 'no-store' });
      return res.ok ? await res.json() : null;
    } catch (err) {
      return null;
    }
  }

  async function loadInsights() {
    const [topics, potential, archive] = await Promise.all([
      fetchJson('topics.json'), fetchJson('potential.json'), fetchJson('archive.json'),
    ]);
    INSIGHTS.topics = topics;
    INSIGHTS.potential = potential;
    INSIGHTS.archive = archive;
    renderTopics();
    renderPotential();
    setView(viewOfPeriod(currentPeriod()));
  }

  /* ── P1 趋势话题 ─────────────────────────────────────── */
  function renderTopics() {
    const data = INSIGHTS.topics;
    // 可见性统一由 setView() 决定，这里只负责画内容（避免加载顺序竞争时提前显形）
    if (!data || !data.topics || !data.topics.length) return;

    const maxCount = Math.max(...data.topics.map((t) => t.repo_count), 1);
    $('#topicsSub').textContent = `${data.project_count} 个项目归成 ${data.topics.length} 个方向`;
    $('#topicsNote').textContent = data.basis || '';

    const box = $('#topicList');
    box.innerHTML = '';
    data.topics.forEach((t, idx) => {
      const row = el('div', 'topic');
      row.style.setProperty('--i', String(idx));
      const head = el('div', 'topic-head');
      head.append(el('span', 'topic-name', t.name));
      head.append(el('span', 'topic-stat', `${t.repo_count} 个 · ${Math.round(t.share * 100)}%`));
      row.append(head);

      const bar = el('div', 'topic-bar');
      const fill = el('span', 'topic-fill');
      fill.style.width = '0%';
      bar.append(fill);
      row.append(bar);
      const target = `${Math.round((t.repo_count / maxCount) * 100)}%`;
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => { fill.style.width = target; });
      });

      const meta = el('div', 'topic-meta');
      meta.append(el('span', '', `本期新增 ${fmt(t.stars_period_total)} star`));
      if (t.languages && t.languages.length) {
        meta.append(el('span', 'dot-sep', t.languages.filter((l) => l && l !== '-').slice(0, 3).join(' / ')));
      }
      row.append(meta);

      const chips = el('div', 'topic-repos');
      for (const r of t.repos.slice(0, 4)) {
        const chip = el('button', 'chip', r.full_name);
        chip.type = 'button';
        chip.addEventListener('click', () => openDrawer({
          full_name: r.full_name,
          language: r.language,
          stars_total: r.stars_total,
          stars_period: r.stars_period,
        }));
        chips.append(chip);
      }
      row.append(chips);
      box.append(row);
    });
  }

  /* ── P2 潜力观察 ─────────────────────────────────────── */
  function renderPotential() {
    const data = INSIGHTS.potential;
    // 同上：只画内容，不碰 hidden
    if (!data || !data.items || !data.items.length) return;

    $('#potentialSub').textContent = `从 ${data.candidate_count} 个候选里挑出 ${data.items.length} 个`;
    $('#potentialNote').textContent = data.method || '';

    const list = $('#potentialList');
    list.innerHTML = '';
    const maxGain = Math.max(...data.items.map((i) => i.stars_period || 0), 1);
    data.items.forEach((it, i) => {
      const li = el('li', `item item--clickable${i === 0 ? ' item--lead' : ''}`);
      li.style.setProperty('--i', String(i));
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.setAttribute('aria-label', `查看 ${it.full_name} 详情`);
      li.append(el('span', 'rank', String(i + 1).padStart(2, '0')));

      const main = el('div', 'item-main');
      const nameRow = el('div', 'name-row');
      nameRow.append(el('span', 'name', it.full_name));
      nameRow.append(el('span', 'score', it.score.toFixed(1)));
      main.append(nameRow);

      const meta = el('div', 'meta');
      if (it.language && it.language !== '-') {
        meta.append(langDot(it.language));
        meta.append(el('span', 'badge badge--lang', it.language));
      }
      meta.append(el('span', 'dot-sep', `本期 +${fmt(it.stars_period)}`));
      meta.append(gainBar(it.stars_period || 0, maxGain));
      meta.append(el('span', 'dot-sep', `${fmt(it.stars_total)} stars`));
      const growthLabel = it.growth >= 1
        ? `新增占累计 ${Math.round((it.stars_period / it.stars_total) * 100)}%`
        : `存量涨幅 ${Math.round(it.growth * 100)}%`;
      meta.append(el('span', 'badge badge--up', growthLabel));
      if (INTERP[it.full_name]) meta.append(el('span', 'badge badge--ai', '中文解读'));
      main.append(meta);

      if (it.reasons && it.reasons.length) main.append(el('p', 'desc', it.reasons.slice(0, 2).join(' · ')));
      li.append(main);

      const open = () => openDrawer(it);
      li.addEventListener('click', open);
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
      list.append(li);
    });
  }

  /* ── 数据说明（替代直接打开原始 meta.json）───────────── */
  function openDataDrawer() {
    const a = INSIGHTS.archive;
    const body = [];

    if (!a) {
      body.push(el('p', 'notice', '数据说明还没生成（archive.json 缺失），请看原始文件。'));
    } else {
      const s = a.summary || {};
      const grid = el('div', 'stat-grid');
      const stats = [
        ['快照', fmt(s.snapshot_count)],
        ['仓库', fmt(s.repo_count)],
        ['上榜记录', fmt(s.index_rows)],
        ['已解读', fmt(s.interpreted_count)],
        ['起始', s.first_date || '—'],
        ['体积', `${Math.round((s.total_bytes || 0) / 1024)} KB`],
      ];
      for (const [label, value] of stats) {
        const cell = el('div', 'stat');
        cell.append(el('div', 'stat-value', String(value)));
        cell.append(el('div', 'stat-label', label));
        grid.append(cell);
      }
      body.push(el('h3', 'sec-title', '归档概览'));
      body.push(grid);

      if (a.snapshots && a.snapshots.length) {
        body.push(el('h3', 'sec-title', '快照清单'));
        const table = el('table', 'data-table');
        const thead = el('thead');
        const hr = el('tr');
        for (const h of ['日期', '期', '条数', '新/续/掉', '大小']) hr.append(el('th', '', h));
        thead.append(hr);
        table.append(thead);
        const tbody = el('tbody');
        for (const snap of a.snapshots.slice(0, 30)) {
          const tr = el('tr');
          tr.append(el('td', '', snap.date));
          tr.append(el('td', '', LABEL[snap.period] || snap.period));
          tr.append(el('td', 'num', String(snap.count)));
          const sig = snap.signals || {};
          tr.append(el('td', 'num', `${sig.new ?? '—'} / ${sig.continued ?? '—'} / ${sig.dropped ?? '—'}`));
          tr.append(el('td', 'num', `${Math.round((snap.bytes || 0) / 1024 * 10) / 10} KB`));
          tbody.append(tr);
        }
        table.append(tbody);
        body.push(table);
      }

      if (a.fields) {
        body.push(el('h3', 'sec-title', '字段说明'));
        const dl = el('dl', 'field-list');
        for (const f of a.fields) {
          dl.append(el('dt', 'field-key', f.field));
          dl.append(el('dd', 'field-desc', f.desc));
        }
        body.push(dl);
      }

      if (a.files) {
        body.push(el('h3', 'sec-title', '文件清单'));
        const ul = el('ul', 'sec-list sec-list--check');
        for (const f of a.files) {
          const li = el('li', 'sec-item');
          li.append(el('span', 'sec-mark', '·'));
          li.append(el('span', 'sec-item-text', `${f.name} — ${f.desc}`));
          ul.append(li);
        }
        body.push(ul);
      }
    }

    const actions = el('div', 'drawer-actions');
    for (const [label, href] of [['原始 meta.json', 'data/meta.json'], ['归档索引', 'data/archive.json']]) {
      const link = el('a', 'btn btn--ghost', label);
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener';
      actions.append(link);
    }
    body.push(actions);

    showDrawer({
      eyebrow: 'ARCHIVE DATA',
      title: '数据说明',
      meta: [el('span', 'dot-sep', a ? `更新于 ${(a.generated_at || '').replace('T', ' ').slice(0, 16)}` : '尚无摘要')],
      body,
    });
  }

  /* ── 历史榜单：全部上榜项目的累计视图（按累计 star 降序）── */
  async function loadHistory() {
    setKpiLoading(true);
    const data = await fetchJson('history.json');
    if (!data || !data.items || !data.items.length) {
      const kpis = kpiReset();
      if (kpis) kpis.append(el('p', 'notice', 'history.json 还没生成（需先跑 scripts/history.py）。'));
      return;
    }
    renderHistory(data);
  }

  function renderHistory(data) {
    const items = data.items;
    $('#rankTitle').textContent = '历史榜单';
    $('#rankHint').textContent = '全部上榜项目 · 累计 star 降序';
    $('#block-github').hidden = true;
    setView('rank');
    const bits = [`累计 ${data.snapshot_count} 期快照`];
    if (data.first_date) bits.push(`${data.first_date} → ${data.latest_date}`);
    bits.push(`去重 ${data.project_count} 个项目`);
    $('#controlsMeta').textContent = bits.join(' · ');
    $('#notice').hidden = true;
    ['#block-new', '#block-hot', '#block-drop', '#block-empty'].forEach((s) => {
      const node = $(s);
      if (node) node.hidden = true;
    });

    const kpis = kpiReset();
    const pc = data.period_counts || {};
    const cards = [
      { label: '累计项目', value: data.project_count, hint: '去重后的全部项目', cls: '' },
      { label: '上榜记录', value: data.index_rows, hint: '含同一项目多次上榜', cls: 'kpi--new' },
      { label: '跨榜项目', value: data.cross_board_count, hint: '出现在 2 个以上榜单', cls: 'kpi--hot' },
      {
        label: '覆盖期数',
        value: data.snapshot_count,
        hint: `日 ${pc.daily || 0} · 周 ${pc.weekly || 0} · 月 ${pc.monthly || 0}`,
        cls: '',
      },
    ];
    let kpiDelay = 0;
    for (const c of cards) {
      const card = el('div', `kpi ${c.cls}`.trim());
      card.append(el('div', 'kpi-label', c.label));
      const valueNode = el('div', 'kpi-value', '0');
      card.append(valueNode);
      card.append(el('div', 'kpi-hint', c.hint));
      kpis.append(card);
      const delay = kpiDelay;
      setTimeout(() => countUp(valueNode, c.value), delay);
      kpiDelay += 70;
    }

    $('#block-history').hidden = false;
    const sub = $('#histSub');
    sub.textContent = `去重 ${data.project_count} 个 · 按累计 star 降序`;
    sub.title = data.basis || '';
    $('#histCount').textContent = String(items.length);

    const list = $('#list-history');
    list.innerHTML = '';
    items.forEach((it, i) => {
      const li = el('li', `item item--clickable${i === 0 ? ' item--lead' : ''}`);
      li.style.setProperty('--i', String(Math.min(i, 30)));
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.setAttribute('aria-label', `查看 ${it.full_name} 详情`);
      /* 这里是「体量榜」序号，不用 #N —— 与 GitHub 总榜名次区分开 */
      li.append(el('span', 'rank', String(it.place).padStart(2, '0')));

      const main = el('div', 'item-main');
      main.append(el('span', 'name', it.full_name));
      if (it.description) main.append(el('p', 'desc', it.description));

      const meta = el('div', 'meta');
      if (it.language && it.language !== '-') {
        meta.append(langDot(it.language));
        meta.append(el('span', 'badge badge--lang', it.language));
      }
      meta.append(el('span', 'dot-sep', `${fmt(it.stars_total)} stars`));
      if (it.appearances > 1) meta.append(el('span', 'badge badge--hot', `上榜 ${it.appearances} 次`));
      else meta.append(el('span', 'dot-sep', '上榜 1 次'));
      for (const label of it.period_labels || []) meta.append(el('span', 'badge badge--period', label));
      if (it.best_rank) meta.append(el('span', 'dot-sep', `榜内最好 #${it.best_rank}`));
      if (it.first_seen) meta.append(el('span', 'dot-sep', `首次 ${it.first_seen}`));
      if (INTERP[it.full_name]) meta.append(el('span', 'badge badge--ai', '中文解读'));
      main.append(meta);
      li.append(main);

      const open = () => openDrawer(it);
      li.addEventListener('click', open);
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
      list.append(li);
    });

    $('#footSource').textContent =
      `历史榜单 · 覆盖 ${data.snapshot_count} 期快照（${data.first_date || '—'} → ${data.latest_date || '—'}）`
      + ` · 按累计 star 总量降序 · ${(data.generated_at || '').replace('T', ' ').slice(0, 16)} 生成`;
  }

  /* 周期 → 视图：只有 topics / potential 是独立视图，其余都进榜单列 */
  function viewOfPeriod(period) {
    if (period === 'topics') return 'topics';
    if (period === 'potential') return 'potential';
    return 'rank';
  }

  /* ── 视图切换：三类内容各自占满整页（榜单列 / 趋势话题 / 潜力观察）── */
  function setView(view) {
    const rank = $('#rankCol');
    const topics = $('#topics');
    const pot = $('#potential');
    const isTopics = view === 'topics';
    const isPot = view === 'potential';
    if (rank) rank.hidden = isTopics || isPot;
    if (topics) topics.hidden = !isTopics;
    if (pot) pot.hidden = !isPot;
    $('#notice').hidden = true;
  }

  /* 加载态：保留 4 格骨架，只切换 is-loading，KPI 条高度恒定不跳 */
  function ensureKpiShell() {
    const kpis = $('#kpis');
    if (!kpis || kpis.querySelector('.kpi')) return;
    kpis.innerHTML = '';
    for (let i = 0; i < 4; i++) {
      const card = el('div', 'kpi');
      card.append(el('div', 'kpi-label', '\u00A0'));
      card.append(el('div', 'kpi-value', '\u00A0'));
      card.append(el('div', 'kpi-hint', '\u00A0'));
      kpis.append(card);
    }
  }
  function setKpiLoading(on) {
    const kpis = $('#kpis');
    if (!kpis) return;
    if (on) ensureKpiShell();
    kpis.classList.toggle('is-loading', on);
  }
  function kpiReset() {
    const kpis = $('#kpis');
    if (!kpis) return null;
    kpis.innerHTML = '';
    kpis.classList.remove('is-loading');
    return kpis;
  }

  /* 通用 KPI 渲染（新视图用，老视图保留原有实现） */
  function paintKpis(cards) {
    const kpis = kpiReset();
    if (!kpis) return;
    let delay = 0;
    for (const c of cards) {
      const card = el('div', `kpi ${c.cls || ''}`.trim());
      card.append(el('div', 'kpi-label', c.label));
      const valueNode = el('div', 'kpi-value', '0');
      card.append(valueNode);
      card.append(el('div', 'kpi-hint', c.hint));
      kpis.append(card);
      const numeric = Number(c.value);
      if (Number.isFinite(numeric)) {
        const d = delay;
        setTimeout(() => countUp(valueNode, numeric), d);
      } else {
        valueNode.textContent = String(c.value);
      }
      delay += 70;
    }
  }

  /* ── 趋势话题（独立 tab）── */
  function loadTopicsView() {
    const data = INSIGHTS.topics;
    setView('topics');
    const meta = $('#controlsMeta');
    if (!data) {                       // insights 还没到：只显示加载骨架
      setKpiLoading(true);
      if (meta) meta.textContent = '正在读取话题数据…';
      return;
    }
    if (!data.topics || !data.topics.length) {
      paintKpis([{ label: '状态', value: '暂无数据', hint: 'topics.json 未生成' }]);
      if (meta) meta.textContent = '暂无话题数据';
      return;
    }
    const top = data.topics[0];
    const starsSum = data.topics.reduce((sum, t) => sum + (t.stars_period_total || 0), 0);
    paintKpis([
      { label: '归类项目', value: data.project_count, hint: '最近一期三榜去重后的项目' },
      { label: '话题数', value: data.topics.length, hint: '一个项目最多 3 个标签' },
      { label: '最大方向', value: top.repo_count, hint: `${top.name} · ${Math.round(top.share * 100)}%`, cls: 'kpi--new' },
      { label: '新增合计', value: starsSum, hint: '按话题累加，跨话题项目会重复计入' },
    ]);
    if (meta) {
      meta.textContent = `${data.project_count} 个项目归成 ${data.topics.length} 个方向`
        + ` · ${(data.generated_at || '').replace('T', ' ').slice(0, 16)} 生成`;
    }
    $('#footSource').textContent = `趋势话题 · ${data.basis || '按名称+描述关键词归类'} · 纯统计，不调模型`;
  }

  /* ── 潜力观察（独立 tab）── */
  function loadPotentialView() {
    const data = INSIGHTS.potential;
    setView('potential');
    const meta = $('#controlsMeta');
    if (!data) {                       // insights 还没到：只显示加载骨架
      setKpiLoading(true);
      if (meta) meta.textContent = '正在读取潜力数据…';
      return;
    }
    if (!data.items || !data.items.length) {
      paintKpis([{ label: '状态', value: '暂无数据', hint: 'potential.json 未生成' }]);
      if (meta) meta.textContent = '暂无潜力数据';
      return;
    }
    const best = data.items[0];
    paintKpis([
      { label: '候选', value: data.candidate_count, hint: '通过体量与增量过滤' },
      { label: '入选', value: data.items.length, hint: '按潜力分取前 N', cls: 'kpi--new' },
      { label: '最高分', value: Math.round(best.score), hint: best.full_name },
      { label: '排除', value: data.excluded_count, hint: '头部 >15 万★ 或单期 <200★' },
    ]);
    if (meta) {
      meta.textContent = `${data.candidate_count} 个候选里挑出 ${data.items.length} 个`
        + ` · ${(data.generated_at || '').replace('T', ' ').slice(0, 16)} 生成`;
    }
    $('#footSource').textContent = `潜力观察 · ${data.method || '纯统计评分'} · 不调模型`;
  }

  /* ── GitHub 总榜：浏览器端直连官方搜索 API，不落盘、不归档 ── */
  const GH_API = 'https://api.github.com/search/repositories?q=stars:%3E1000&sort=stars&order=desc';
  const GH_PER_PAGE = 100;
  const GH_PAGES = 3;
  const GH_TARGET = GH_PER_PAGE * GH_PAGES;
  let ghCountdown = null;

  function ghAgo(iso) {
    if (!iso) return '—';
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (days <= 0) return '今天';
    if (days === 1) return '昨天';
    if (days < 30) return `${days} 天前`;
    if (days < 365) return `${Math.floor(days / 30)} 个月前`;
    return `${Math.floor(days / 365)} 年前`;
  }

  /* 限额状态写到 controlsMeta（这个位置在主站里本来放快照元信息） */
  function setGhStatus(rate, extra) {
    if (ghCountdown) { clearInterval(ghCountdown); ghCountdown = null; }
    const meta = $('#controlsMeta');
    if (!rate || rate.limit === null || rate.limit === undefined) {
      meta.textContent = extra || '';
      return;
    }
    const left = Number(rate.remaining);
    const stamp = extra ? ` · ${extra}` : '';
    if (left > 0) {
      meta.textContent = `API 限额 剩余 ${left}/${rate.limit} 次 · 每分钟重置${stamp}`;
      return;
    }
    const resetMs = Number(rate.reset) * 1000;
    const tick = () => {
      const secs = Math.max(0, Math.ceil((resetMs - Date.now()) / 1000));
      if (secs <= 0) {
        meta.textContent = '限额已重置 · 点「重新拉取」';
        if (ghCountdown) { clearInterval(ghCountdown); ghCountdown = null; }
        return;
      }
      meta.textContent = `限额已用尽 · ${secs} 秒后恢复`;
    };
    tick();
    ghCountdown = setInterval(tick, 1000);
  }

  function ghReadRate(headers) {
    return {
      limit: headers.get('x-ratelimit-limit'),
      remaining: headers.get('x-ratelimit-remaining'),
      reset: headers.get('x-ratelimit-reset'),
    };
  }

  async function ghFetchPage(page) {
    const res = await fetch(`${GH_API}&per_page=${GH_PER_PAGE}&page=${page}`, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });
    const rate = ghReadRate(res.headers);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body && body.message) msg = body.message;
      } catch (e) { /* 非 JSON */ }
      const err = new Error(msg);
      err.rate = rate;
      throw err;
    }
    const data = await res.json();
    if (!data.items || !data.items.length) {
      const err = new Error('API 返回 0 条结果');
      err.rate = rate;
      throw err;
    }
    return { items: data.items, total: data.total_count, rate };
  }

  async function loadGithub() {
    const list = $('#list-github');
    const notice = $('#notice');
    const btn = $('#ghRefresh');
    notice.hidden = true;
    $('#block-github').hidden = false;
    ['#block-new', '#block-hot', '#block-drop', '#block-empty', '#block-history'].forEach((s) => {
      const node = $(s);
      if (node) node.hidden = true;
    });
    $('#rankTitle').textContent = 'GitHub 总榜';
    $('#rankHint').textContent = '全部仓库 · 按 star 总数';
    $('#ghSub').textContent = `前 ${GH_TARGET} 名 · ${GH_PAGES} 页并行`;
    setView('rank');
    list.classList.add('is-loading');
    if (btn) btn.disabled = true;
    $('#controlsMeta').textContent = `正在并行拉取 ${GH_PAGES} 页（每页 ${GH_PER_PAGE} 条）…`;
    const kpis = $('#kpis');
    setKpiLoading(true);

    const pages = Array.from({ length: GH_PAGES }, (_, i) => i + 1);
    const results = await Promise.allSettled(pages.map((p) => ghFetchPage(p)));

    const failedIdx = results.map((r, i) => (r.status === 'rejected' ? i : -1)).filter((i) => i >= 0);
    if (failedIdx.length) {
      $('#controlsMeta').textContent = `有 ${failedIdx.length} 页失败，正在重试…`;
      for (const i of failedIdx) {
        try {
          results[i] = { status: 'fulfilled', value: await ghFetchPage(pages[i]) };
        } catch (err) {
          results[i] = { status: 'rejected', reason: err };
        }
      }
    }

    const seen = new Set();
    const items = [];
    let total = null;
    let rate = null;
    let failure = null;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        if (total === null) total = r.value.total;
        if (r.value.rate) rate = r.value.rate;
        for (const it of r.value.items) {
          if (seen.has(it.full_name)) continue;
          seen.add(it.full_name);
          items.push(it);
        }
      } else if (!failure) {
        const reason = r.reason || {};
        failure = { page: pages[i], message: reason.message || '请求失败' };
        if (reason.rate) rate = reason.rate;
      }
    });
    items.sort((a, b) => b.stargazers_count - a.stargazers_count);

    if (!items.length) {
      kpiReset();
      list.classList.remove('is-loading');
      kpis.append(el('p', 'notice', `拉取失败：${(failure && failure.message) || '未知错误'}`));
      setGhStatus(rate, '拉取失败');
      notice.hidden = false;
      notice.textContent = `GitHub 总榜拉取失败：${(failure && failure.message) || '未知错误'}`
        + '。点「重新拉取」重试，或等一分钟限额窗口重置。';
      if (btn) btn.disabled = false;
      return;
    }
    renderGithub(items, { total: total || 0, rate, partial: failure });
    if (btn) btn.disabled = false;
  }

  function renderGithub(items, meta) {
    const notice = $('#notice');
    notice.hidden = true;
    const ghList = $('#list-github');
    if (ghList) ghList.classList.remove('is-loading');
    const partial = meta.partial || null;
    const top = items[0];
    const last = items[items.length - 1];
    const languages = new Set(items.map((i) => i.language).filter(Boolean));

    const kpis = kpiReset();
    const cards = [
      { label: '榜首', value: top.stargazers_count, hint: top.full_name, cls: '' },
      { label: `第 ${items.length} 名门槛`, value: last.stargazers_count, hint: `★ 至少 ${fmt(last.stargazers_count)}`, cls: 'kpi--new' },
      { label: '全站命中', value: meta.total, hint: 'star > 1,000 的仓库总数', cls: '' },
      { label: '覆盖语言', value: languages.size, hint: `${items.length} 个项目的去重语言数`, cls: '' },
    ];
    let kpiDelay = 0;
    for (const c of cards) {
      const card = el('div', `kpi ${c.cls}`.trim());
      card.append(el('div', 'kpi-label', c.label));
      const valueNode = el('div', 'kpi-value', '0');
      card.append(valueNode);
      card.append(el('div', 'kpi-hint', c.hint));
      kpis.append(card);
      const delay = kpiDelay;
      setTimeout(() => countUp(valueNode, c.value), delay);
      kpiDelay += 70;
    }

    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    $('#ghSub').textContent = `${items.length} 条 · star > 1000 共 ${fmt(meta.total)} 个`;
    setGhStatus(meta.rate, partial ? `第 ${partial.page} 页失败` : `${stamp} 拉取`);
    $('#footSource').textContent =
      `GitHub 总榜 · 前端直连 api.github.com（${GH_PAGES} 次请求，不落盘）`
      + ` · 命中 ${fmt(meta.total)} 个 star>1000 的仓库 · 显示前 ${items.length} 名`;

    if (partial) {
      notice.hidden = false;
      notice.textContent = `只拉到 ${items.length} 条：第 ${partial.page} 页请求失败（${partial.message}）。`
        + '点「重新拉取」可补全，或等一分钟限额窗口重置。';
    }

    const list = $('#list-github');
    list.innerHTML = '';
    items.forEach((it, i) => {
      const li = el('li', `item item--clickable${i === 0 ? ' item--lead' : ''}`);
      li.style.setProperty('--i', String(Math.min(i, 24)));

      const main = el('div', 'item-main');
      main.append(el('span', 'name', it.full_name));
      if (it.description) main.append(el('p', 'desc', it.description));

      const m = el('div', 'meta');
      if (it.language) {
        m.append(langDot(it.language));
        m.append(el('span', 'badge badge--lang', it.language));
      }
      m.append(el('span', 'dot-sep', `${fmt(it.forks_count)} forks`));
      if (it.open_issues_count !== undefined) {
        m.append(el('span', 'dot-sep', `${fmt(it.open_issues_count)} issues`));
      }
      if (it.created_at) m.append(el('span', 'badge badge--period', `建仓 ${it.created_at.slice(0, 4)}`));
      if (it.license && it.license.spdx_id && it.license.spdx_id !== 'NOASSERTION') {
        m.append(el('span', 'dot-sep', it.license.spdx_id));
      }
      if (it.pushed_at) m.append(el('span', 'dot-sep', `更新 ${ghAgo(it.pushed_at)}`));
      main.append(m);

      const rank = el('span', 'rank', String(i + 1).padStart(2, '0'));
      rank.title = `按 star 总数排序第 ${i + 1} 名`;
      li.append(rank);
      li.append(main);

      const count = el('span', 'stars-count');
      count.append(el('span', '', `★ ${fmt(it.stargazers_count)}`));
      count.append(el('small', '', 'stars'));
      li.append(count);

      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.setAttribute('aria-label', `查看 ${it.full_name} 详情`);
      const open = () => openDrawer({
        full_name: it.full_name,
        url: it.html_url,
        language: it.language,
        stars_total: it.stargazers_count,
        description: it.description,
      });
      li.addEventListener('click', open);
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
      list.append(li);
    });
  }

  async function load(period) {
    if (period === 'history') { loadHistory(); return; }
    if (period === 'github') { loadGithub(); return; }
    if (period === 'topics') { loadTopicsView(); return; }
    if (period === 'potential') { loadPotentialView(); return; }
    setKpiLoading(true);
    try {
      const res = await fetch(`data/latest-${period}.json`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      render(await res.json());
    } catch (err) {
      const kpis = kpiReset();
      if (kpis) {
        const box = el('p', 'notice');
        box.textContent = `读取 data/latest-${period}.json 失败（${err.message}）。请确认快照已生成。`;
        kpis.append(box);
      }
      ['#block-new', '#block-hot', '#block-drop', '#block-empty'].forEach((s) => { $(s).hidden = true; });
    }
  }

  function render(data) {
    const items = data.items || [];
    const dropped = data.dropped || [];
    const news = items.filter((i) => i.status === 'new');
    const hots = items.filter((i) => i.status === 'continued');

    $('#block-history').hidden = true;
    $('#block-github').hidden = true;
    $('#rankTitle').textContent = '榜单动态';
    $('#rankHint').textContent = '与上一期对比';
    setView('rank');

    const metaBits = [`${data.date} 快照`];
    if (data.prev_date) {
      const days = Math.round((new Date(data.date) - new Date(data.prev_date)) / 86400000);
      metaBits.push(days > 0 ? `距上一期 ${days} 天` : '与上一期同日');
    } else {
      metaBits.push('首份快照');
    }
    if (data.snapshot_count) metaBits.push(`累计 ${data.snapshot_count} 份`);
    $('#controlsMeta').textContent = metaBits.join(' · ');

    const notice = $('#notice');
    if (!data.prev_date) {
      notice.hidden = false;
      notice.textContent =
        `这是${LABEL[data.period] || ''}的第一份快照，还没有可对比的上一期——` +
        `所以「持续热门」和「掉榜」在下一次抓取后才会出现，本页所有项目暂时都算「新上榜」。`;
    } else {
      notice.hidden = true;
    }

    const kpis = kpiReset();
    const cards = [
      { label: '榜单项目', value: data.signals.total, hint: PERIOD_HINT[data.period] || '', cls: '' },
      { label: '新上榜', value: data.signals.new, hint: '首次进入榜单', cls: 'kpi--new' },
      { label: '持续热门', value: data.signals.continued, hint: '连续多次在榜', cls: 'kpi--hot' },
      { label: '掉榜', value: data.signals.dropped, hint: '从上一快照消失', cls: 'kpi--drop' },
    ];
    let kpiDelay = 0;
    for (const c of cards) {
      const card = el('div', `kpi ${c.cls}`.trim());
      card.append(el('div', 'kpi-label', c.label));
      const valueNode = el('div', 'kpi-value', '0');
      card.append(valueNode);
      card.append(el('div', 'kpi-hint', c.hint));
      kpis.append(card);
      const delay = kpiDelay;
      setTimeout(() => countUp(valueNode, c.value), delay);
      kpiDelay += 70;
    }

    toggleBlock('#block-new', news.length, () => {
      $('#newSub').textContent = `${data.date} 新进 · 左侧 #N 为总榜原始名次`;
      $('#newCount').textContent = String(news.length);
      fillList('#list-new', news, 'new');
    });
    toggleBlock('#block-hot', hots.length, () => {
      const maxStreak = Math.max(...hots.map((i) => i.streak || 1), 1);
      $('#hotSub').textContent = `最长连续 ${maxStreak} 期 · #N 为总榜原始名次`;
      $('#hotCount').textContent = String(hots.length);
      fillList('#list-hot', hots, 'hot');
    });
    toggleBlock('#block-drop', dropped.length, () => {
      $('#dropSub').textContent = `上期（${data.prev_date || '—'}）还在`;
      $('#dropCount').textContent = String(dropped.length);
      fillDropList(dropped);
    });

    const emptyBox = $('#block-empty');
    if (!items.length) {
      emptyBox.hidden = false;
      $('#emptyText').textContent = '这一期没有解析到任何项目，可能是抓取失败，请检查归档日志。';
    } else if (!news.length && !hots.length && !dropped.length) {
      emptyBox.hidden = false;
      $('#emptyText').textContent = '本期与上一期完全一致，没有新上榜也没有掉榜。';
    } else {
      emptyBox.hidden = true;
    }

    $('#footSource').textContent =
      `${LABEL[data.period] || ''}数据 ${data.date} · 来源 ${data.source || 'github.com/trending'} · 抓取于 ${(data.fetched_at || '').replace('T', ' ')}`;
  }

  function toggleBlock(sel, count, renderFn) {
    const block = $(sel);
    if (!count) { block.hidden = true; return; }
    block.hidden = false;
    renderFn();
  }

  function fillList(sel, items, kind) {
    const list = $(sel);
    list.innerHTML = '';
    const maxGain = Math.max(...items.map((i) => i.stars_period || 0), 1);
    items.forEach((it, i) => {
      const li = buildItem(it, kind, maxGain);
      li.style.setProperty('--i', String(i));
      if (i === 0) li.classList.add('item--lead');
      list.append(li);
    });
  }

  function gainBar(value, max, { muted = false } = {}) {
    const wrap = el('span', `gain-bar${muted ? ' gain-bar--muted' : ''}`);
    const fill = el('span', 'gain-fill');
    fill.style.width = `${Math.max(4, Math.round((value / max) * 100))}%`;
    wrap.append(fill);
    return wrap;
  }

  function fillDropList(dropped) {
    const list = $('#list-drop');
    list.innerHTML = '';
    for (const d of dropped) {
      const li = el('li', 'item');
      li.append(rankTag(d.last_rank, '上期'));
      const main = el('div', 'item-main');
      const a = el('a', 'name', d.full_name);
      a.href = d.url || `https://github.com/${d.full_name}`;
      a.target = '_blank';
      a.rel = 'noopener';
      main.append(a);
      const meta = el('div', 'meta');
      if (d.language && d.language !== '-') {
        meta.append(langDot(d.language));
        meta.append(el('span', 'badge badge--lang', d.language));
      }
      if (d.last_stars_total) meta.append(el('span', 'dot-sep', `${fmt(d.last_stars_total)} stars`));
      meta.append(el('span', 'dot-sep', '掉出榜单'));
      main.append(meta);
      li.append(main);
      li.append(el('span', 'badge badge--drop', '掉榜'));
      list.append(li);
    }
  }

  function buildItem(it, kind, maxGain) {
    const hasNotes = Boolean(INTERP[it.full_name]);
    const li = el('li', 'item item--clickable');
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-label', `查看 ${it.full_name} 详情`);
    li.dataset.name = it.full_name;

    li.append(rankTag(it.rank, '本期'));

    const main = el('div', 'item-main');
    main.append(el('span', 'name', it.full_name));
    if (it.description) main.append(el('p', 'desc', it.description));

    const meta = el('div', 'meta');
    if (it.language && it.language !== '-') {
      meta.append(langDot(it.language));
      meta.append(el('span', 'badge badge--lang', it.language));
    }
    meta.append(el('span', 'dot-sep', `${fmt(it.stars_total)} stars`));
    if (it.stars_period !== null && it.stars_period !== undefined) {
      meta.append(el('span', 'dot-sep', `本期 +${fmt(it.stars_period)}`));
      meta.append(gainBar(it.stars_period || 0, maxGain || 1));
    }
    if (it.rank_change !== null && it.rank_change !== undefined && it.rank_change !== 0) {
      const up = it.rank_change > 0;
      meta.append(el('span', `badge ${up ? 'badge--up' : 'badge--down'}`,
        `${up ? '↑' : '↓'} ${Math.abs(it.rank_change)} 位`));
    }
    if (hasNotes) meta.append(el('span', 'badge badge--ai', '中文解读'));
    main.append(meta);
    li.append(main);

    if (kind === 'hot' && it.streak > 1) li.append(el('span', 'badge badge--hot', `连续 ${it.streak} 次`));
    else if (kind === 'new') li.append(el('span', 'badge badge--new', '新上榜'));

    const open = () => openDrawer(it);
    li.addEventListener('click', open);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    return li;
  }

  /* ── 详情抽屉 ─────────────────────────────────────────── */
  const SECTION_DEFS = [
    ['audience', '谁适合关注', 'check'],
    ['use_cases', '能用在哪些工作中', 'check'],
    ['adoption_steps', '建议怎么落地', 'number'],
    ['build_ideas', '可以基于它开发什么', 'check'],
    ['risks', '采用前要确认', 'warn'],
  ];

  /* 抽屉外壳：项目详情与数据说明共用 */
  function showDrawer({ eyebrow, title, meta = [], body = [] }) {
    const drawer = $('#drawer');
    const metaBox = $('#drawerMeta');
    $('#drawerEyebrow').textContent = eyebrow;
    $('#drawerTitle').textContent = title;
    metaBox.innerHTML = '';
    for (const node of meta) metaBox.append(node);
    const bodyBox = $('#drawerBody');
    bodyBox.innerHTML = '';
    for (const node of body) bodyBox.append(node);

    drawer.hidden = false;
    requestAnimationFrame(() => drawer.classList.add('is-open'));
    document.body.style.overflow = 'hidden';
  }

  function openDrawer(it) {
    const rec = INTERP[it.full_name] || null;
    const body = [];

    const metaNodes = [];
    if (it.language && it.language !== '-') metaNodes.push(el('span', 'badge badge--lang', it.language));
    if (it.stars_total !== undefined) metaNodes.push(el('span', 'dot-sep', `${fmt(it.stars_total)} stars`));
    if (it.stars_period !== undefined && it.stars_period !== null) {
      metaNodes.push(el('span', 'dot-sep', `本期 +${fmt(it.stars_period)}`));
    }
    if (it.streak > 1) metaNodes.push(el('span', 'badge badge--hot', `连续 ${it.streak} 次`));

    if (rec) {
      if (rec.one_liner) {
        const box = el('div', 'quote');
        box.append(el('p', 'quote-label', '一句话读懂'));
        box.append(el('p', 'quote-text', rec.one_liner));
        body.push(box);
      }
      if (rec.summary) {
        body.push(el('h3', 'sec-title', '它是什么'));
        body.push(el('p', 'sec-text', rec.summary));
      }
      for (const [key, title, style] of SECTION_DEFS) {
        const arr = Array.isArray(rec[key]) ? rec[key].filter(Boolean) : [];
        if (!arr.length) continue;
        body.push(el('h3', 'sec-title', title));
        const ul = el('ul', `sec-list sec-list--${style}`);
        arr.forEach((text, i) => {
          const li = el('li', 'sec-item');
          li.append(el('span', 'sec-mark', style === 'number' ? String(i + 1) : style === 'warn' ? '!' : '✓'));
          li.append(el('span', 'sec-item-text', text));
          ul.append(li);
        });
        body.push(ul);
      }

      const prov = el('div', 'prov');
      prov.append(el('span', 'badge badge--ai', 'AI 生成'));
      prov.append(el('span', 'prov-text',
        `${rec.model || '未知模型'}${rec.model_resolved && rec.model_resolved !== rec.model ? ` → ${rec.model_resolved}` : ''}`
        + ` · ${(rec.generated_at || '').replace('T', ' ').slice(0, 16)}`
        + ` · README ${rec.readme_used ? '已参考' : '未取到'}`));
      body.push(prov);
    } else {
      body.push(el('p', 'notice', '这个项目还没有生成中文解读（下次抓取时会补上）。下面是 GitHub 原始描述。'));
    }

    const desc = (rec && rec.source_description) || it.description;
    if (desc) {
      body.push(el('h3', 'sec-title', 'GitHub 原始描述'));
      body.push(el('p', 'sec-text sec-text--dim', desc));
    }

    const actions = el('div', 'drawer-actions');
    const gh = el('a', 'btn btn--primary', '查看 GitHub');
    gh.href = it.url || `https://github.com/${it.full_name}`;
    gh.target = '_blank';
    gh.rel = 'noopener';
    actions.append(gh);
    body.push(actions);

    showDrawer({
      eyebrow: rec ? 'AI 中文解读' : 'PROJECT NOTES',
      title: it.full_name,
      meta: metaNodes,
      body,
    });
  }

  function closeDrawer() {
    const drawer = $('#drawer');
    drawer.classList.remove('is-open');
    document.body.style.overflow = '';
    setTimeout(() => { drawer.hidden = true; }, 180);
  }

  $('#drawer').addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeDrawer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer();
  });

  /* 启动 */
  let stored = 'paper';
  try { stored = localStorage.getItem('trend.skin') || 'paper'; } catch (e) { /* noop */ }
  applySkin(stored, { persist: false });
  const skinToggle = $('#skinToggle');
  if (skinToggle) {
    skinToggle.addEventListener('click', () => {
      const cur = document.documentElement.dataset.skin || 'paper';
      applySkin(cur === 'paper' ? 'slate' : 'paper');
    });
  }

  document.querySelectorAll('.segmented button').forEach((btn) => {
    btn.addEventListener('click', () => setPeriod(btn.dataset.period));
  });

  const ghRefresh = $('#ghRefresh');
  if (ghRefresh) ghRefresh.addEventListener('click', () => loadGithub());

  /* ── 右下角快捷滚动：↑ 回到顶部 / ↓ 回到底部 ── */
  const toTop = $('#toTop');
  const toBottom = $('#toBottom');
  const jumpBehavior = REDUCED ? 'auto' : 'smooth';
  function updateJumpButtons() {
    const y = window.scrollY || window.pageYOffset || 0;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (toTop) toTop.classList.toggle('is-off', y < 120);
    if (toBottom) toBottom.classList.toggle('is-off', y >= max - 120);
  }
  if (toTop) {
    toTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: jumpBehavior }));
  }
  if (toBottom) {
    toBottom.addEventListener('click', () => {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: jumpBehavior });
    });
  }
  let jumpTick = false;
  window.addEventListener('scroll', () => {
    if (jumpTick) return;
    jumpTick = true;
    requestAnimationFrame(() => { jumpTick = false; updateJumpButtons(); });
  }, { passive: true });
  window.addEventListener('resize', updateJumpButtons);
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(updateJumpButtons).observe(document.body);
  }
  updateJumpButtons();

  const dataLink = $('#dataLink');
  if (dataLink) {
    dataLink.addEventListener('click', (e) => {
      e.preventDefault();
      openDataDrawer();
    });
  }
  document.querySelectorAll('.topnav a[data-nav]').forEach((a) => {
    a.addEventListener('click', () => {
      document.querySelectorAll('.topnav a').forEach((x) => x.classList.remove('is-active'));
      a.classList.add('is-active');
    });
  });
  window.addEventListener('resize', moveIndicator);

  (async () => {
    const period = currentPeriod();
    // 先落 tab 与视图：慢网络下也不该让 ?p=topics 显示成日榜
    setPeriod(period, { push: false });
    await loadInterpretations();
    await loadInsights();
    // 话题/潜力视图的内容与 KPI 依赖 insights，数据到位后补一帧
    if (viewOfPeriod(period) !== 'rank') load(period);
    moveIndicator();
    window.addEventListener('load', moveIndicator);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveIndicator);
  })();
})();
