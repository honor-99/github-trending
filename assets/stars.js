/* GitHub Star 总榜 · 独立页面，纯前端直连 GitHub 官方 API，不保存任何数据 */
(() => {
  'use strict';

  /* star > 1000 的仓库共 6 万多个，取 sort=stars 的前 100（per_page 上限 = 100 = 1 次请求） */
  const API = 'https://api.github.com/search/repositories'
    + '?q=stars:%3E1000&sort=stars&order=desc&per_page=100';

  const $ = (sel) => document.querySelector(sel);
  const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('zh-CN'));

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  /* ── 外观皮肤（与主站共享 localStorage 键）── */
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

  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function countUp(node, target) {
    const value = Number(target);
    if (REDUCED || !Number.isFinite(value)) { node.textContent = String(target); return; }
    const start = performance.now();
    const tick = (now) => {
      const p = Math.min((now - start) / 620, 1);
      node.textContent = String(Math.round(value * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function ago(iso) {
    if (!iso) return '—';
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (days <= 0) return '今天';
    if (days === 1) return '昨天';
    if (days < 30) return `${days} 天前`;
    if (days < 365) return `${Math.floor(days / 30)} 个月前`;
    return `${Math.floor(days / 365)} 年前`;
  }

  /* ── 限额状态条 ── */
  let countdownTimer = null;
  function setRate({ limit, remaining, reset }) {
    const node = $('#rateStatus');
    if (!node) return;
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    if (limit === null || limit === undefined) { node.hidden = true; return; }
    node.hidden = false;
    node.classList.remove('is-low', 'is-empty');
    const left = Number(remaining);
    node.textContent = `API 限额 剩余 ${left}/${limit} 次 · 每分钟重置`;
    if (left <= 0) node.classList.add('is-empty');
    else if (left <= 2) node.classList.add('is-low');
    if (left > 0 || !reset) return;
    const resetMs = Number(reset) * 1000;
    const render = () => {
      const secs = Math.max(0, Math.ceil((resetMs - Date.now()) / 1000));
      if (secs <= 0) {
        node.textContent = '限额已重置，点「重新拉取」即可';
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
        return;
      }
      node.textContent = `限额已用尽 · ${secs} 秒后恢复`;
    };
    render();
    countdownTimer = setInterval(render, 1000);
  }

  function readRate(headers) {
    return {
      limit: headers.get('x-ratelimit-limit'),
      remaining: headers.get('x-ratelimit-remaining'),
      reset: headers.get('x-ratelimit-reset'),
    };
  }

  function setKpis(cards) {
    const kpis = $('#kpis');
    kpis.innerHTML = '';
    let delay = 0;
    for (const c of cards) {
      const card = el('div', `kpi ${c.cls || ''}`.trim());
      card.append(el('div', 'kpi-label', c.label));
      const valueNode = el('div', 'kpi-value', '0');
      card.append(valueNode);
      card.append(el('div', 'kpi-hint', c.hint));
      kpis.append(card);
      const numeric = Number(c.value);
      if (Number.isFinite(numeric)) setTimeout(() => countUp(valueNode, numeric), delay);
      else valueNode.textContent = String(c.value);
      delay += 70;
    }
  }

  function render(items, meta) {
    const notice = $('#notice');
    notice.hidden = true;

    const languages = new Set(items.map((i) => i.language).filter(Boolean));
    const top = items[0];
    const last = items[items.length - 1];
    setKpis([
      { label: '榜首', value: top.stargazers_count, hint: top.full_name },
      { label: `第 ${items.length} 名门槛`, value: last.stargazers_count, hint: `★ 至少 ${fmt(last.stargazers_count)}` },
      { label: '全站命中', value: meta.total, hint: 'star > 1,000 的仓库总数' },
      { label: '覆盖语言', value: languages.size, hint: `${items.length} 个项目的去重语言数` },
    ]);

    $('#status').textContent = `拉取于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} · ${items.length} 条`;
    $('#colHint').textContent = `第 1–${items.length} 名 · 实时`;
    $('#footSource').textContent =
      `数据来源：GitHub 官方搜索 API · 命中 ${fmt(meta.total)} 个 star>1000 的仓库 · 本页展示前 ${items.length} 名`;

    const list = $('#starList');
    list.innerHTML = '';
    items.forEach((it, i) => {
      const li = el('li', `item item--clickable${i === 0 ? ' item--lead' : ''}`);
      li.style.setProperty('--i', String(Math.min(i, 24)));
      li.append(el('span', 'rank', String(i + 1).padStart(2, '0')));

      const main = el('div', 'item-main');
      const nameRow = el('div', 'name-row');
      nameRow.append(el('span', 'name', it.full_name));
      main.append(nameRow);
      if (it.description) main.append(el('p', 'desc', it.description));

      const meta_ = el('div', 'meta');
      if (it.language) {
        meta_.append(langDot(it.language));
        meta_.append(el('span', 'badge badge--lang', it.language));
      }
      meta_.append(el('span', 'dot-sep', `${fmt(it.forks_count)} forks`));
      if (it.open_issues_count !== undefined) {
        meta_.append(el('span', 'dot-sep', `${fmt(it.open_issues_count)} issues`));
      }
      const year = it.created_at ? it.created_at.slice(0, 4) : null;
      if (year) meta_.append(el('span', 'badge badge--period', `建仓 ${year}`));
      if (it.license && it.license.spdx_id && it.license.spdx_id !== 'NOASSERTION') {
        meta_.append(el('span', 'dot-sep', it.license.spdx_id));
      }
      if (it.pushed_at) meta_.append(el('span', 'dot-sep', `更新 ${ago(it.pushed_at)}`));
      main.append(meta_);
      li.append(main);

      const count = el('span', 'stars-count');
      count.append(el('span', '', `★ ${fmt(it.stargazers_count)}`));
      count.append(el('small', '', 'stars'));
      li.append(count);

      li.tabIndex = 0;
      li.setAttribute('role', 'link');
      li.setAttribute('aria-label', `在新窗口打开 ${it.full_name}（${fmt(it.stargazers_count)} stars）`);
      const open = () => window.open(it.html_url, '_blank', 'noopener');
      li.addEventListener('click', open);
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
      list.append(li);
    });
  }

  async function load() {
    const status = $('#status');
    const notice = $('#notice');
    const list = $('#starList');
    notice.hidden = true;
    status.textContent = '正在请求 api.github.com…';
    $('#reloadBtn').disabled = true;
    list.innerHTML = '';
    setKpis([{ label: '状态', value: '读取中', hint: 'api.github.com', cls: '' }]);

    try {
      const res = await fetch(API, {
        headers: { Accept: 'application/vnd.github+json' },
        cache: 'no-store',
      });
      const rate = readRate(res.headers);
      setRate({ limit: rate.limit, remaining: rate.remaining, reset: rate.reset });

      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (body && body.message) msg = body.message;
        } catch (e) { /* 非 JSON 响应 */ }
        throw new Error(msg);
      }

      const data = await res.json();
      if (!data.items || !data.items.length) throw new Error('API 返回 0 条结果');
      render(data.items, { total: data.total_count });
    } catch (err) {
      status.textContent = '拉取失败';
      setKpis([{ label: '状态', value: '失败', hint: err.message.slice(0, 40), cls: '' }]);
      notice.hidden = false;
      notice.textContent = err.message.includes('rate limit')
        ? `触发 GitHub 限额：${err.message} 点击右上「重新拉取」，或等一分钟窗口重置。`
        : `拉取失败：${err.message}。可能是网络或限额问题，点右上「重新拉取」重试。`;
    } finally {
      $('#reloadBtn').disabled = false;
    }
  }

  /* ── 启动 ── */
  let stored = 'paper';
  try { stored = localStorage.getItem('trend.skin') || 'paper'; } catch (e) { /* noop */ }
  applySkin(stored, { persist: false });

  const skinToggle = $('#skinToggle');
  if (skinToggle) {
    skinToggle.addEventListener('click', () => {
      applySkin((document.documentElement.dataset.skin || 'paper') === 'paper' ? 'slate' : 'paper');
    });
  }
  $('#reloadBtn').addEventListener('click', load);

  load();
})();
