/* GitHub 热度追踪 · 纯静态渲染（无依赖、无构建） */
(() => {
  'use strict';

  const LABEL = { daily: '日榜', weekly: '周榜', monthly: '月榜' };
  const PERIOD_HINT = { daily: '今日增长榜', weekly: '本周增长榜', monthly: '本月增长榜' };

  const $ = (sel) => document.querySelector(sel);
  const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('zh-CN'));

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

  function currentPeriod() {
    const p = new URLSearchParams(location.search).get('p');
    return LABEL[p] ? p : 'daily';
  }

  function setPeriod(period, { push = true } = {}) {
    document.querySelectorAll('.segmented button').forEach((b) => {
      b.setAttribute('aria-selected', String(b.dataset.period === period));
    });
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
  }

  /* ── P1 趋势话题 ─────────────────────────────────────── */
  function renderTopics() {
    const data = INSIGHTS.topics;
    const section = $('#topics');
    if (!data || !data.topics || !data.topics.length) { section.hidden = true; return; }
    section.hidden = false;

    const maxCount = Math.max(...data.topics.map((t) => t.repo_count), 1);
    $('#topicsSub').textContent = `${data.project_count} 个项目归成 ${data.topics.length} 个方向`;
    $('#topicsNote').textContent = data.basis || '';

    const box = $('#topicList');
    box.innerHTML = '';
    for (const t of data.topics) {
      const row = el('div', 'topic');
      const head = el('div', 'topic-head');
      head.append(el('span', 'topic-name', t.name));
      head.append(el('span', 'topic-stat', `${t.repo_count} 个 · ${Math.round(t.share * 100)}%`));
      row.append(head);

      const bar = el('div', 'topic-bar');
      const fill = el('span', 'topic-fill');
      fill.style.width = `${Math.round((t.repo_count / maxCount) * 100)}%`;
      bar.append(fill);
      row.append(bar);

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
    }
  }

  /* ── P2 潜力观察 ─────────────────────────────────────── */
  function renderPotential() {
    const data = INSIGHTS.potential;
    const section = $('#potential');
    if (!data || !data.items || !data.items.length) { section.hidden = true; return; }
    section.hidden = false;

    $('#potentialSub').textContent = `从 ${data.candidate_count} 个候选里挑出 ${data.items.length} 个`;
    $('#potentialNote').textContent = data.method || '';

    const list = $('#potentialList');
    list.innerHTML = '';
    data.items.forEach((it, i) => {
      const li = el('li', 'item item--clickable');
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
      if (it.language && it.language !== '-') meta.append(el('span', 'badge badge--lang', it.language));
      meta.append(el('span', 'dot-sep', `本期 +${fmt(it.stars_period)}`));
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

  async function load(period) {
    const kpis = $('#kpis');
    kpis.innerHTML = '';
    kpis.append(el('p', 'notice', '正在读取快照…'));
    try {
      const res = await fetch(`data/latest-${period}.json`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      render(await res.json());
    } catch (err) {
      kpis.innerHTML = '';
      const box = el('p', 'notice');
      box.textContent = `读取 data/latest-${period}.json 失败（${err.message}）。请确认快照已生成。`;
      kpis.append(box);
      ['#block-new', '#block-hot', '#block-drop', '#block-empty'].forEach((s) => { $(s).hidden = true; });
    }
  }

  function render(data) {
    const items = data.items || [];
    const dropped = data.dropped || [];
    const news = items.filter((i) => i.status === 'new');
    const hots = items.filter((i) => i.status === 'continued');

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

    const kpis = $('#kpis');
    kpis.innerHTML = '';
    const cards = [
      { label: '榜单项目', value: data.signals.total, hint: PERIOD_HINT[data.period] || '', cls: '' },
      { label: '新上榜', value: data.signals.new, hint: '首次进入榜单', cls: 'kpi--new' },
      { label: '持续热门', value: data.signals.continued, hint: '连续多次在榜', cls: 'kpi--hot' },
      { label: '掉榜', value: data.signals.dropped, hint: '从上一快照消失', cls: 'kpi--drop' },
    ];
    for (const c of cards) {
      const card = el('div', `kpi ${c.cls}`.trim());
      card.append(el('div', 'kpi-label', c.label));
      card.append(el('div', 'kpi-value', String(c.value)));
      card.append(el('div', 'kpi-hint', c.hint));
      kpis.append(card);
    }

    toggleBlock('#block-new', news.length, () => {
      $('#newSub').textContent = `${data.date} 刚进入视野`;
      fillList('#list-new', news, 'new');
    });
    toggleBlock('#block-hot', hots.length, () => {
      const maxStreak = Math.max(...hots.map((i) => i.streak || 1), 1);
      $('#hotSub').textContent = `最长连续 ${maxStreak} 期`;
      fillList('#list-hot', hots, 'hot');
    });
    toggleBlock('#block-drop', dropped.length, () => {
      $('#dropSub').textContent = `上一期（${data.prev_date || '—'}）还在，这一期消失`;
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
    for (const it of items) list.append(buildItem(it, kind));
  }

  function fillDropList(dropped) {
    const list = $('#list-drop');
    list.innerHTML = '';
    for (const d of dropped) {
      const li = el('li', 'item');
      li.append(el('span', 'rank', `#${d.last_rank}`));
      const main = el('div', 'item-main');
      const a = el('a', 'name', d.full_name);
      a.href = d.url || `https://github.com/${d.full_name}`;
      a.target = '_blank';
      a.rel = 'noopener';
      main.append(a);
      const meta = el('div', 'meta');
      if (d.language && d.language !== '-') meta.append(el('span', 'badge badge--lang', d.language));
      if (d.last_stars_total) meta.append(el('span', 'dot-sep', `${fmt(d.last_stars_total)} stars`));
      meta.append(el('span', 'dot-sep', '掉出榜单'));
      main.append(meta);
      li.append(main);
      li.append(el('span', 'badge badge--drop', '掉榜'));
      list.append(li);
    }
  }

  function buildItem(it, kind) {
    const hasNotes = Boolean(INTERP[it.full_name]);
    const li = el('li', 'item item--clickable');
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-label', `查看 ${it.full_name} 详情`);
    li.dataset.name = it.full_name;

    li.append(el('span', 'rank', `#${it.rank}`));

    const main = el('div', 'item-main');
    main.append(el('span', 'name', it.full_name));
    if (it.description) main.append(el('p', 'desc', it.description));

    const meta = el('div', 'meta');
    if (it.language && it.language !== '-') meta.append(el('span', 'badge badge--lang', it.language));
    meta.append(el('span', 'dot-sep', `${fmt(it.stars_total)} stars`));
    if (it.stars_period !== null && it.stars_period !== undefined) {
      meta.append(el('span', 'dot-sep', `本期 +${fmt(it.stars_period)}`));
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
  document.querySelectorAll('.segmented button').forEach((btn) => {
    btn.addEventListener('click', () => setPeriod(btn.dataset.period));
  });

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

  (async () => {
    await loadInterpretations();
    await loadInsights();
    setPeriod(currentPeriod(), { push: false });
  })();
})();
