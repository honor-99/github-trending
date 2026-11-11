/* GitHub 热度追踪 · 纯静态渲染（无依赖、无构建） */
(() => {
  'use strict';

  const LABEL = { daily: '日榜', weekly: '周榜', monthly: '月榜' };
  const PERIOD_HINT = {
    daily: '今日增长榜',
    weekly: '本周增长榜',
    monthly: '本月增长榜',
  };

  const $ = (sel) => document.querySelector(sel);
  const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('zh-CN'));

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

    /* 顶部元信息 */
    const metaBits = [`${data.date} 快照`];
    if (data.prev_date) {
      const days = Math.round((new Date(data.date) - new Date(data.prev_date)) / 86400000);
      metaBits.push(days > 0 ? `距上一期 ${days} 天` : '与上一期同日');
    } else {
      metaBits.push('首份快照');
    }
    if (data.snapshot_count) metaBits.push(`累计 ${data.snapshot_count} 份`);
    $('#controlsMeta').textContent = metaBits.join(' · ');

    /* 首份快照提示（无对比基线时不假装有信号） */
    const notice = $('#notice');
    if (!data.prev_date) {
      notice.hidden = false;
      notice.textContent =
        `这是${LABEL[data.period] || ''}的第一份快照，还没有可对比的上一期——` +
        `所以「持续热门」和「掉榜」在下一次抓取后才会出现，本页所有项目暂时都算「新上榜」。`;
    } else {
      notice.hidden = true;
    }

    /* KPI 卡 */
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

    /* 新上榜 */
    toggleBlock('#block-new', news.length, () => {
      $('#newSub').textContent = `${data.date} 刚进入视野`;
      fillList('#list-new', news, 'new');
    });

    /* 持续热门 */
    toggleBlock('#block-hot', hots.length, () => {
      const maxStreak = Math.max(...hots.map((i) => i.streak || 1), 1);
      $('#hotSub').textContent = `最长连续 ${maxStreak} 期`;
      fillList('#list-hot', hots, 'hot');
    });

    /* 掉榜 */
    toggleBlock('#block-drop', dropped.length, () => {
      $('#dropSub').textContent = `上一期（${data.prev_date || '—'}）还在，这一期消失`;
      fillDropList(dropped);
    });

    /* 空态 */
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

    /* 页脚 */
    $('#footSource').textContent =
      `${LABEL[data.period] || ''}数据 ${data.date} · 来源 ${data.source || 'github.com/trending'} · 抓取于 ${(data.fetched_at || '').replace('T', ' ')}`;
  }

  function toggleBlock(sel, count, render) {
    const block = $(sel);
    if (!count) { block.hidden = true; return; }
    block.hidden = false;
    render();
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
    const li = el('li', 'item');
    li.append(el('span', 'rank', `#${it.rank}`));

    const main = el('div', 'item-main');
    const a = el('a', 'name', it.full_name);
    a.href = it.url || `https://github.com/${it.full_name}`;
    a.target = '_blank';
    a.rel = 'noopener';
    main.append(a);

    if (it.description) main.append(el('p', 'desc', it.description));

    const meta = el('div', 'meta');
    if (it.language && it.language !== '-') {
      meta.append(el('span', 'badge badge--lang', it.language));
    }
    meta.append(el('span', 'dot-sep', `${fmt(it.stars_total)} stars`));
    if (it.stars_period !== null && it.stars_period !== undefined) {
      const periodWord = kind === 'new' ? '本期' : '本期';
      meta.append(el('span', 'dot-sep', `${periodWord} +${fmt(it.stars_period)}`));
    }
    if (it.rank_change !== null && it.rank_change !== undefined && it.rank_change !== 0) {
      const up = it.rank_change > 0;
      meta.append(
        el('span', `badge ${up ? 'badge--up' : 'badge--down'}`, `${up ? '↑' : '↓'} ${Math.abs(it.rank_change)} 位`)
      );
    }
    main.append(meta);
    li.append(main);

    if (kind === 'hot' && it.streak > 1) {
      li.append(el('span', 'badge badge--hot', `连续 ${it.streak} 次`));
    } else if (kind === 'new') {
      li.append(el('span', 'badge badge--new', '新上榜'));
    }
    return li;
  }

  /* 启动 */
  document.querySelectorAll('.segmented button').forEach((btn) => {
    btn.addEventListener('click', () => setPeriod(btn.dataset.period));
  });
  setPeriod(currentPeriod(), { push: false });
})();
