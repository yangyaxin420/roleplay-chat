/* ============================================================
   角色扮演 · 前端逻辑
   纯静态，无依赖。数据存 IndexedDB（失败时退回 localStorage）。
   ============================================================ */
(() => {
  'use strict';

  /* ------------------------------------------------ 工具 */

  const $ = (sel, root = document) => root.querySelector(sel);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const now = () => Date.now();
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));

  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    if (sameDay) return `今天 ${p(d.getHours())}:${p(d.getMinutes())}`;
    return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /* ------------------------------------------------ 默认值 */

  const DEFAULT_SETTINGS = {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    temperature: 0.9,
    maxTokens: 800,
    contextMessages: 24,
    fontSize: 100,
    lengthMode: 'medium',
    systemTemplate: ''
  };

  /* 回复长度档位：hint 会写进系统提示，tokens 是硬上限 */
  const LENGTH_PRESETS = {
    short: { label: '短', hint: '100~200 字', tokens: 420 },
    medium: { label: '中', hint: '200~400 字', tokens: 900 },
    long: { label: '长', hint: '400~800 字', tokens: 1900 },
    custom: { label: '自定', hint: '', tokens: null }
  };

  const DEFAULT_PROMPT = `你正在进行一场沉浸式角色扮演，全程不要出戏。

【你的角色】{{char}}
{{persona}}

【对方】{{user}}
【情境】
{{scenario}}

【扮演规则】
1. 你就是{{char}}本人。用第一人称说话和行动，不要跳出角色，不要提及自己是 AI、模型、助手，不要解释设定或写旁白注解。
2. 只写{{char}}的言行、神态与内心。绝对不要替{{user}}说话，不要替{{user}}做决定，也不要描述{{user}}的心理活动。
3. 描写要有画面感：动作、语气、停顿、环境细节。克制、具体，避免空洞的形容词堆砌，避免大段独白式的自我剖析。
4. 篇幅要跟着情境走，不要为了长而长；具体字数见最后的长度要求。
5. {{char}}的真实内心必须单独写在【心理】与【/心理】之间，放在整段回复的最后；正文里不要再重复这份心理内容。
   格式示例：
   “……（对话与动作描写）”
   【心理】此刻真正在想的东西，可以坦白，也可以自欺。【/心理】
6. 不要使用列表、标题、代码块这类排版，像小说一样自然分段。`;

  /* ------------------------------------------------ 存储 */

  const LS_SESSIONS = 'rp.sessions.v1';
  const LS_SETTINGS = 'rp.settings.v1';
  const DB_NAME = 'rp-db';
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('no-idb'));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('sessions')) {
          db.createObjectStore('sessions', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((e) => { dbPromise = null; throw e; });
    return dbPromise;
  }

  const idb = {
    async all() {
      const db = await openDB();
      return new Promise((res, rej) => {
        const rq = db.transaction('sessions', 'readonly').objectStore('sessions').getAll();
        rq.onsuccess = () => res(rq.result || []);
        rq.onerror = () => rej(rq.error);
      });
    },
    async put(session) {
      const db = await openDB();
      return new Promise((res, rej) => {
        const tx = db.transaction('sessions', 'readwrite');
        tx.objectStore('sessions').put(session);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    },
    async del(id) {
      const db = await openDB();
      return new Promise((res, rej) => {
        const tx = db.transaction('sessions', 'readwrite');
        tx.objectStore('sessions').delete(id);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    }
  };

  function lsSessions() {
    try { return JSON.parse(localStorage.getItem(LS_SESSIONS) || '[]'); }
    catch { return []; }
  }

  const Store = {
    async all() {
      try { return await idb.all(); }
      catch { return lsSessions(); }
    },
    async put(s) {
      try { await idb.put(s); }
      catch {
        const list = lsSessions().filter((x) => x.id !== s.id);
        list.push(s);
        localStorage.setItem(LS_SESSIONS, JSON.stringify(list));
      }
    },
    async del(id) {
      try { await idb.del(id); }
      catch {
        localStorage.setItem(LS_SESSIONS, JSON.stringify(lsSessions().filter((x) => x.id !== id)));
      }
    }
  };

  /* ------------------------------------------------ 状态 */

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    sessions: [],
    currentId: null,
    streaming: false,
    abortCtrl: null,
    editingId: null,
    setupEditId: null,
    setupOriginal: null,
    setupBusy: false,
    peeked: new Set()
  };

  const MAX_MESSAGES = 1000;

  const el = {
    app: $('#app'),
    sidebar: $('#sidebar'),
    overlay: $('#overlay'),
    sessionList: $('#sessionList'),
    messages: $('#messages'),
    input: $('#input'),
    sendBtn: $('#btnSend'),
    chatTitle: $('#chatTitle'),
    chatSub: $('#chatSub'),
    thoughtBtn: $('#btnThought'),
    lengthBtn: $('#btnLength'),
    fileImport: $('#fileImport'),
    setup: $('#setupModal'),
    settings: $('#settingsModal'),
    confirm: $('#confirmModal'),
    ctxMenu: $('#ctxMenu'),
    moreMenu: $('#moreMenu'),
    toast: $('#toast')
  };

  const cur = () => state.sessions.find((s) => s.id === state.currentId) || null;

  /* ------------------------------------------------ 提示 / 确认 */

  let toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2200);
  }

  let confirmResolve = null;
  function askConfirm(title, text, okText = '确定') {
    return new Promise((resolve) => {
      $('#confirmTitle').textContent = title;
      $('#confirmText').textContent = text;
      $('#btnConfirmYes').textContent = okText;
      el.confirm.classList.add('open');
      confirmResolve = resolve;
    });
  }
  function settleConfirm(v) {
    el.confirm.classList.remove('open');
    if (confirmResolve) { confirmResolve(v); confirmResolve = null; }
  }

  /* ------------------------------------------------ Markdown 极简渲染 */

  function mdToHtml(src) {
    let t = esc(src);
    t = t.replace(/```([\s\S]*?)```/g, (_, c) => `<pre><code>${c.replace(/^\n+|\n+$/g, '')}</code></pre>`);
    t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    return t
      .split(/\n{2,}/)
      .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  /* 把内容拆成 正文 / 心理 片段 */
  const MARKERS = [
    ['【心理】', '【/心理】'],
    ['[心理]', '[/心理]'],
    ['（心理：', '）']
  ];

  function parseSegments(text) {
    const out = [];
    let i = 0;
    while (i < text.length) {
      let best = -1;
      let pair = null;
      for (const p of MARKERS) {
        const idx = text.indexOf(p[0], i);
        if (idx !== -1 && (best === -1 || idx < best)) { best = idx; pair = p; }
      }
      if (best === -1) { out.push({ type: 'text', text: text.slice(i) }); break; }
      if (best > i) out.push({ type: 'text', text: text.slice(i, best) });
      const start = best + pair[0].length;
      const close = text.indexOf(pair[1], start);
      if (close === -1) { out.push({ type: 'thought', text: text.slice(start) }); break; }
      out.push({ type: 'thought', text: text.slice(start, close) });
      i = close + pair[1].length;
    }
    return out.filter((s) => s.text.trim().length > 0);
  }

  function bubbleInner(content, streaming) {
    if (!content && streaming) {
      return '<div class="typing"><i></i><i></i><i></i></div>';
    }
    const segs = parseSegments(content);
    return segs.map((seg) => {
      if (seg.type === 'thought') {
        return `<div class="thought">${esc(seg.text).replace(/\n/g, '<br>')}</div>`;
      }
      return mdToHtml(seg.text);
    }).join('');
  }

  /* ------------------------------------------------ 侧栏 */

  function renderSidebar() {
    const list = [...state.sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (!list.length) {
      el.sessionList.innerHTML = '<div class="empty-note">还没有存档<br>点上面「新建对话」开始</div>';
      return;
    }
    el.sessionList.innerHTML = list.map((s) => `
      <div class="session-item ${s.id === state.currentId ? 'active' : ''}" data-id="${s.id}">
        <div class="session-info">
          <div class="session-name">${esc(s.title || s.charName || '未命名')}</div>
          <div class="session-meta">${s.messages ? s.messages.length : 0} 条 · ${fmtTime(s.updatedAt || s.createdAt)}</div>
        </div>
        <button class="session-more" data-more="${s.id}" title="更多">⋯</button>
      </div>
    `).join('');
  }

  function openSidebar() {
    el.sidebar.classList.add('open');
    el.overlay.classList.add('open');
  }
  function closeSidebar() {
    el.sidebar.classList.remove('open');
    el.overlay.classList.remove('open');
  }

  const isMobile = () => window.matchMedia('(max-width: 860px)').matches;

  function toggleSidebar() {
    if (isMobile()) {
      if (el.sidebar.classList.contains('open')) closeSidebar();
      else openSidebar();
      return;
    }
    el.app.classList.toggle('collapsed');
    try {
      localStorage.setItem('rp.sidebarCollapsed', el.app.classList.contains('collapsed') ? '1' : '0');
    } catch { /* ignore */ }
  }

  /* ------------------------------------------------ 消息区 */

  function hasThoughts(m) {
    return parseSegments(m.content || '').some((seg) => seg.type === 'thought');
  }

  function actionsHtml(m, isLast, s) {
    const btns = [];
    let always = false;
    if (m.role === 'assistant' && s && s.showThoughts === false && hasThoughts(m)) {
      always = true;
      btns.push(`<button data-act="peek">${state.peeked.has(m.id) ? '收起' : '看心理'}</button>`);
    }
    btns.push('<button data-act="copy">复制</button>');
    if (m.role === 'user') btns.push('<button data-act="edit">编辑</button>');
    if (m.role === 'assistant' && isLast && !m.error) btns.push('<button data-act="regen">重写</button>');
    btns.push('<button data-act="del" class="danger">删除</button>');
    return `<div class="msg-actions${always ? ' always' : ''}">${btns.join('')}</div>`;
  }

  function messageHtml(m, idx, list, s) {
    const isLast = idx === list.length - 1;
    const peeking = state.peeked.has(m.id);

    if (m.role === 'user') {
      if (state.editingId === m.id) {
        return `
          <div class="msg user" id="m-${m.id}" data-id="${m.id}">
            <div class="msg-body edit-box">
              <textarea data-edit-input="${m.id}">${esc(m.content)}</textarea>
              <div class="edit-actions">
                <button class="ghost-btn small-btn" data-act="cancel-edit">取消</button>
                <button class="primary-btn small-btn" data-act="save-edit">保存并重发</button>
              </div>
            </div>
          </div>`;
      }
      return `
        <div class="msg user" id="m-${m.id}" data-id="${m.id}">
          <div class="msg-body">
            <div class="bubble">${esc(m.content)}</div>
            ${actionsHtml(m, isLast, s)}
          </div>
        </div>`;
    }

    if (m.error) {
      return `
        <div class="msg assistant" id="m-${m.id}" data-id="${m.id}">
          <div class="msg-body">
            <div class="msg-error">
              <span>${esc(m.error)}</span>
              <button data-act="retry">重试</button>
            </div>
            ${actionsHtml(m, isLast, s)}
          </div>
        </div>`;
    }

    const streaming = state.streaming && isLast;
    return `
      <div class="msg assistant ${peeking ? 'peek' : ''}" id="m-${m.id}" data-id="${m.id}">
        <div class="msg-body">
          <div class="bubble">${bubbleInner(m.content, streaming)}${streaming && m.content ? '<span class="cursor"></span>' : ''}</div>
          ${actionsHtml(m, isLast, s)}
        </div>
      </div>`;
  }

  function emptyStateHtml(s) {
    const who = s.charName || '对方';
    return `
      <div class="empty-state">
        <div class="glyph">— 幕 起 —</div>
        <h2>${esc(s.scenario ? '情境已经搭好了' : '还没有开始')}</h2>
        <p>${esc(s.scenario ? s.scenario.slice(0, 60) + (s.scenario.length > 60 ? '…' : '') : '先开口，或者让 TA 先来。')}</p>
        <button class="link-btn" data-act="kickoff">让 ${esc(who)} 先开口</button>
      </div>`;
  }

  function renderMessages() {
    const s = cur();
    if (!s) {
      el.messages.innerHTML = `<div class="messages-inner">
        <div class="empty-state">
          <div class="glyph">— — —</div>
          <h2>还没有对话</h2>
          <p>先写下角色和情境，<br>再决定由谁先开口。</p>
          <button class="link-btn" data-act="new-session">新建对话</button>
        </div>
      </div>`;
      return;
    }
    const stick = isNearBottom();
    const prevTop = el.messages.scrollTop;
    let html = '<div class="messages-inner">';
    if (!s.messages.length) html += emptyStateHtml(s);
    html += s.messages.map((m, i) => messageHtml(m, i, s.messages, s)).join('');
    html += '</div>';
    el.messages.innerHTML = html;
    if (stick) scrollBottom(true);
    else el.messages.scrollTop = prevTop;
  }

  function renderHeader() {
    const s = cur();
    el.chatTitle.textContent = s ? (s.title || s.charName || '对话') : '未开始';
    const n = s ? s.messages.length : 0;
    el.chatSub.textContent = s ? `${n} / ${MAX_MESSAGES} 条 · ${s.charName}` : '还没有对话';
    el.chatSub.classList.toggle('warn', !!s && n >= MAX_MESSAGES - 20);
    const show = s ? s.showThoughts !== false : true;
    el.thoughtBtn.classList.toggle('active', show);
    el.messages.classList.toggle('hide-thoughts', !show);
    el.thoughtBtn.disabled = !s;
    const preset = LENGTH_PRESETS[state.settings.lengthMode] || LENGTH_PRESETS.medium;
    if (el.lengthBtn) el.lengthBtn.textContent = preset.label;
    updateComposer();
  }

  function updateComposer() {
    const s = cur();
    const full = !s || s.messages.length + 2 > MAX_MESSAGES;
    el.input.disabled = full;
    el.input.placeholder = !s
      ? '先新建一段对话'
      : full
        ? `到 ${MAX_MESSAGES} 条上限了，新建一段继续`
        : '说点什么…';
    el.sendBtn.disabled = full;
  }

  function renderAll() {
    renderHeader();
    renderMessages();
    renderSidebar();
  }

  function isNearBottom() {
    const m = el.messages;
    return m.scrollHeight - m.scrollTop - m.clientHeight < 140;
  }
  function scrollBottom(instant) {
    el.messages.scrollTo({ top: el.messages.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
  }

  /* ------------------------------------------------ 持久化 */

  async function persist(s) {
    if (!s) return;
    s.updatedAt = now();
    try {
      await Store.put(s);
    } catch {
      toast('保存失败：浏览器存储空间可能满了');
    }
    const idx = state.sessions.findIndex((x) => x.id === s.id);
    if (idx >= 0) state.sessions[idx] = s;
  }

  /* ------------------------------------------------ 请求 */

  function systemPrompt(s) {
    const tpl = (state.settings.systemTemplate || '').trim() || DEFAULT_PROMPT;
    const preset = LENGTH_PRESETS[state.settings.lengthMode];
    const lengthNote = preset && preset.hint
      ? `\n\n【本次回复长度】正文控制在 ${preset.hint} 之间，心理描写不计入这个字数。`
      : '';
    return tpl
      .replace(/\{\{char\}\}/g, s.charName || '角色')
      .replace(/\{\{user\}\}/g, s.userName || '我')
      .replace(/\{\{persona\}\}/g, s.persona || '（未填写）')
      .replace(/\{\{scenario\}\}/g, s.scenario || '（未填写）') + lengthNote;
  }

  function buildMessages(s, extraUser) {
    const limit = Math.max(2, Number(state.settings.contextMessages) || 24);
    let hist = s.messages
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.error && m.content && m.content.trim())
      .slice(-limit);
    while (hist.length && hist[0].role === 'assistant') hist.shift();

    const out = [{ role: 'system', content: systemPrompt(s) }];
    for (const m of hist) out.push({ role: m.role, content: m.content.trim() });
    if (extraUser) out.push({ role: 'user', content: extraUser });
    return out;
  }

  function apiUrl() {
    let base = (state.settings.baseUrl || DEFAULT_SETTINGS.baseUrl).trim().replace(/\/+$/, '');
    if (!/\/chat\/completions$/.test(base)) base += '/chat/completions';
    return base;
  }

  async function describeError(res) {
    let detail = '';
    try {
      const j = await res.json();
      detail = (j.error && (j.error.message || j.error)) || '';
    } catch { /* ignore */ }
    if (res.status === 401) return 'API Key 无效，去设置里检查一下';
    if (res.status === 402) return '账户余额不足';
    if (res.status === 429) return '请求太频繁，稍等一下再试';
    if (res.status === 400 && /context|token/i.test(String(detail))) return '对话太长了，到设置里调小「携带上下文条数」';
    return `请求失败（${res.status}）${detail ? '：' + String(detail).slice(0, 120) : ''}`;
  }

  async function readStream(res, onChunk) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        let json;
        try { json = JSON.parse(data); } catch { continue; }
        const delta = json.choices && json.choices[0] && json.choices[0].delta;
        if (delta && typeof delta.content === 'string' && delta.content) onChunk(delta.content);
      }
    }
  }

  let streamId = null;
  let streamText = '';
  let rafQueued = false;

  function paintStream(id, text) {
    streamId = id;
    streamText = text;
    if (rafQueued) return;
    rafQueued = true;
    requestAnimationFrame(() => {
      rafQueued = false;
      const node = document.getElementById('m-' + streamId);
      if (!node) { renderMessages(); return; }
      const bubble = node.querySelector('.bubble');
      if (!bubble) { renderMessages(); return; }
      const stick = isNearBottom();
      bubble.innerHTML = bubbleInner(streamText, true) + '<span class="cursor"></span>';
      if (stick) scrollBottom(true);
    });
  }

  function setSending(on) {
    el.sendBtn.classList.toggle('stop', on);
    el.sendBtn.title = on ? '停止生成' : '发送';
    el.sendBtn.innerHTML = on
      ? '<span class="stop-square"></span>'
      : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>';
  }

  async function requestReply(s, extraUser) {
    if (state.streaming) return;
    const key = (state.settings.apiKey || '').trim();
    if (!key) { openSettings(); toast('先填一下 API Key'); return; }
    if (s.messages.length >= MAX_MESSAGES) {
      toast(`这段对话到 ${MAX_MESSAGES} 条上限了`);
      renderAll();
      return;
    }

    while (s.messages.length && s.messages[s.messages.length - 1].error) s.messages.pop();

    const msg = { id: uid(), role: 'assistant', content: '', createdAt: now() };
    s.messages.push(msg);
    state.streaming = true;
    state.abortCtrl = new AbortController();
    setSending(true);
    renderMessages();
    scrollBottom(true);

    const lengthPreset = LENGTH_PRESETS[state.settings.lengthMode] || LENGTH_PRESETS.medium;
    const body = {
      model: state.settings.model,
      messages: buildMessages(s, extraUser),
      stream: true,
      max_tokens: lengthPreset.tokens || Math.max(50, Number(state.settings.maxTokens) || 800)
    };
    if (!String(state.settings.model).includes('reasoner')) {
      body.temperature = Number(state.settings.temperature);
    }

    let acc = '';
    try {
      const res = await fetch(apiUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + key
        },
        body: JSON.stringify(body),
        signal: state.abortCtrl.signal
      });
      if (!res.ok) throw new Error(await describeError(res));
      await readStream(res, (chunk) => {
        acc += chunk;
        msg.content = acc;
        paintStream(msg.id, acc);
      });
      msg.content = acc.trim();
      if (!msg.content) msg.error = '没有收到内容，再试一次？';
    } catch (err) {
      if (err && err.name === 'AbortError') {
        msg.content = acc.trim();
        if (!msg.content) s.messages.pop();
      } else {
        msg.content = acc.trim();
        msg.error = err instanceof TypeError
          ? '连不上接口：检查网络，或确认接口地址填对了'
          : (err && err.message) || '请求失败';
      }
    } finally {
      state.streaming = false;
      state.abortCtrl = null;
      setSending(false);
      renderMessages();
      scrollBottom();
      await persist(s);
      renderSidebar();
      renderHeader();
    }
  }

  /* ------------------------------------------------ 动作 */

  async function sendMessage() {
    const s = cur();
    if (!s) { openSetup(); return; }
    if (state.streaming) return;
    if (!(state.settings.apiKey || '').trim()) { openSettings(); toast('先填一下 API Key'); return; }
    if (s.messages.length + 2 > MAX_MESSAGES) {
      toast(`这段对话到 ${MAX_MESSAGES} 条上限了，新建一段继续吧`);
      return;
    }
    const text = el.input.value.trim();
    if (!text) return;
    state.editingId = null;
    s.messages.push({ id: uid(), role: 'user', content: text, createdAt: now() });
    el.input.value = '';
    autosize();
    renderMessages();
    scrollBottom(true);
    await persist(s);
    renderSidebar();
    await requestReply(s);
  }

  async function regenerate() {
    const s = cur();
    if (!s || state.streaming) return;
    while (s.messages.length && (s.messages[s.messages.length - 1].role === 'assistant')) {
      s.messages.pop();
    }
    renderMessages();
    await requestReply(s);
  }

  async function deleteMessage(id) {
    const s = cur();
    if (!s) return;
    const idx = s.messages.findIndex((m) => m.id === id);
    if (idx === -1) return;
    if (!(await askConfirm('删除这条消息？', '删除后无法恢复。这一步不会重新生成。', '删除'))) return;
    s.messages.splice(idx, 1);
    renderMessages();
    await persist(s);
    renderSidebar();
  }

  function startEdit(id) {
    state.editingId = id;
    renderMessages();
    const ta = el.messages.querySelector(`textarea[data-edit-input="${id}"]`);
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.style.height = Math.min(ta.scrollHeight + 4, 300) + 'px';
    }
  }

  async function saveEdit(id) {
    const s = cur();
    if (!s) return;
    const ta = el.messages.querySelector(`textarea[data-edit-input="${id}"]`);
    if (!ta) return;
    const text = ta.value.trim();
    if (!text) { toast('不能为空'); return; }
    const idx = s.messages.findIndex((m) => m.id === id);
    if (idx === -1) return;

    const after = s.messages.length - idx - 1;
    if (after > 0) {
      const ok = await askConfirm(
        '修改后会重新生成',
        `这条消息之后还有 ${after} 条内容，保存后会全部删除，并从这条重新往下写。`,
        '保存并重发'
      );
      if (!ok) return;
    }
    s.messages[idx].content = text;
    s.messages.length = idx + 1;
    state.editingId = null;
    renderMessages();
    await persist(s);
    await requestReply(s);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
    }
  }

  /* ------------------------------------------------ 存档操作 */

  async function createSession(data) {
    const session = {
      id: uid(),
      title: data.charName || '未命名',
      charName: data.charName || '角色',
      userName: data.userName || '我',
      persona: data.persona || '',
      scenario: data.scenario || '',
      showThoughts: false,
      thoughtV2: true,
      messages: [],
      createdAt: now(),
      updatedAt: now()
    };
    if (data.opening && data.opening.trim()) {
      session.messages.push({ id: uid(), role: 'assistant', content: data.opening.trim(), createdAt: now() });
    }
    state.sessions.push(session);
    state.currentId = session.id;
    await Store.put(session);
    renderAll();
    return session;
  }

  async function switchTo(id) {
    if (state.streaming && state.abortCtrl) return;
    state.currentId = id;
    state.editingId = null;
    state.peeked.clear();
    renderAll();
    closeSidebar();
    scrollBottom(true);
  }

  async function removeSession(id) {
    const s = state.sessions.find((x) => x.id === id);
    if (!s) return;
    const ok = await askConfirm('删除这段对话？', `「${s.title}」的全部消息都会消失，无法恢复。`, '删除');
    if (!ok) return;
    await Store.del(id);
    state.sessions = state.sessions.filter((x) => x.id !== id);
    if (state.currentId === id) {
      state.currentId = state.sessions.length ? state.sessions[0].id : null;
    }
    renderAll();
    if (!state.currentId) openSetup();
  }

  function exportSession(s) {
    const data = JSON.stringify({ type: 'rp-session', version: 1, session: s }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(s.title || '对话').replace(/[\\/:*?"<>|]/g, '_')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function sessionToText(s) {
    const lines = [];
    lines.push(`【角色】${s.charName}`);
    lines.push(`【我】${s.userName}`);
    lines.push('');
    lines.push('【角色设定】');
    lines.push(s.persona || '（未填写）');
    lines.push('');
    lines.push('【情境】');
    lines.push(s.scenario || '（未填写）');
    lines.push('');
    lines.push('——— 对话记录 ———');
    lines.push('');
    for (const m of s.messages) {
      const who = m.role === 'user' ? s.userName : s.charName;
      if (m.error) continue;
      lines.push(`${who}：${m.content.trim()}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  async function importFile(file) {
    try {
      const text = await file.text();
      const raw = JSON.parse(text);
      const items = Array.isArray(raw) ? raw
        : raw.session ? [raw.session]
        : raw.sessions ? raw.sessions
        : null;
      if (!items) throw new Error('格式不对');
      let added = 0;
      for (const it of items) {
        if (!it || !Array.isArray(it.messages)) continue;
        const session = {
          id: state.sessions.some((x) => x.id === it.id) ? uid() : (it.id || uid()),
          title: it.title || it.charName || '导入的对话',
          charName: it.charName || '角色',
          userName: it.userName || '我',
          persona: it.persona || '',
          scenario: it.scenario || '',
          showThoughts: it.showThoughts !== false,
          thoughtV2: true,
          messages: it.messages.filter((m) => m && m.role && typeof m.content === 'string'),
          createdAt: it.createdAt || now(),
          updatedAt: it.updatedAt || now()
        };
        state.sessions.push(session);
        await Store.put(session);
        added++;
      }
      if (!added) throw new Error('没有可导入的对话');
      state.currentId = state.sessions[state.sessions.length - 1].id;
      renderAll();
      toast(`已导入 ${added} 段对话`);
    } catch (e) {
      toast('导入失败：文件格式不对');
    }
  }

  /* ------------------------------------------------ 设定弹窗 */

  function openSetup(session = null) {
    state.setupEditId = session ? session.id : null;
    $('#fChar').value = session ? session.charName : '';
    $('#fUser').value = session ? session.userName : '';
    $('#fPersona').value = session ? session.persona : '';
    $('#fScenario').value = session ? session.scenario : '';
    $('#fOpening').value = '';
    $('#btnSetupStart').textContent = session ? '保存' : '开始';
    el.setup.querySelector('h2').textContent = session ? '编辑设定' : '开始一段对话';
    el.setup.querySelector('.modal-desc').textContent = session
      ? '改完之后，新设定只影响之后的对话。'
      : '写好人设和情境，之后的一切都按它来。';
    $('#btnSetupCancel').style.display = '';
    state.setupOriginal = setupSnapshot();
    const card = el.setup.querySelector('.modal-card');
    if (card) card.scrollTop = 0;
    el.setup.classList.add('open');
    setTimeout(() => $('#fChar').focus(), 60);
  }

  function setupSnapshot() {
    return {
      char: $('#fChar').value,
      user: $('#fUser').value,
      persona: $('#fPersona').value,
      scenario: $('#fScenario').value,
      opening: $('#fOpening').value
    };
  }

  async function closeSetup(force) {
    if (!force) {
      if (el.confirm.classList.contains('open')) return;
      if (state.setupOriginal) {
        const vals = setupSnapshot();
        const dirty = Object.keys(vals).some(
          (k) => (vals[k] || '').trim() !== (state.setupOriginal[k] || '').trim()
        );
        if (dirty) {
          const ok = await askConfirm('放弃这次填写？', '已经写下的内容不会保存。', '放弃');
          if (!ok) return;
        }
      }
    }
    el.setup.classList.remove('open');
    state.setupEditId = null;
    state.setupOriginal = null;
  }

  async function submitSetup() {
    if (state.setupBusy) return;
    state.setupBusy = true;
    try {
      const charName = $('#fChar').value.trim();
      const persona = $('#fPersona').value.trim();
      if (!charName) { toast('先给角色起个名字'); $('#fChar').focus(); return; }
      if (!persona) { toast('角色设定还是空的'); $('#fPersona').focus(); return; }

      const data = {
        charName,
        userName: $('#fUser').value.trim(),
        persona,
        scenario: $('#fScenario').value.trim(),
        opening: $('#fOpening').value
      };

      if (state.setupEditId) {
        const s = state.sessions.find((x) => x.id === state.setupEditId);
        if (s) {
          s.charName = data.charName;
          s.userName = data.userName || '我';
          s.persona = data.persona;
          s.scenario = data.scenario;
          s.updatedAt = now();
          await Store.put(s);
          renderAll();
        }
        await closeSetup(true);
        toast('设定已更新');
        return;
      }

      const s = await createSession(data);
      await closeSetup(true);
      el.input.focus();
      if (!s.messages.length) toast('设定好了，说第一句吧');
    } finally {
      state.setupBusy = false;
    }
  }

  /* ------------------------------------------------ 设置弹窗 */

  function openSettings() {
    const st = state.settings;
    $('#fKey').value = st.apiKey;
    $('#fKey').type = 'password';
    $('#btnToggleKey').textContent = '显示';
    $('#fModel').value = st.model;
    $('#fTemp').value = st.temperature;
    $('#tempVal').textContent = Number(st.temperature).toFixed(1);
    $('#fMaxTokens').value = st.maxTokens;
    $('#fCtx').value = st.contextMessages;
    $('#fFont').value = st.fontSize;
    $('#fontVal').textContent = st.fontSize + '%';
    $('#fPrompt').value = st.systemTemplate || DEFAULT_PROMPT;
    el.settings.classList.add('open');
  }

  function setLength(key) {
    if (!LENGTH_PRESETS[key]) return;
    state.settings.lengthMode = key;
    try {
      localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings));
    } catch { /* ignore */ }
    renderHeader();
    const p = LENGTH_PRESETS[key];
    toast(`回复字数：${p.label}${p.hint ? '（' + p.hint + '）' : '（用设置里的上限）'}`);
  }

  function applyFont() {
    document.documentElement.style.setProperty('--scale', (state.settings.fontSize / 100).toFixed(3));
  }

  function saveSettings() {
    const key = $('#fKey').value.trim();
    state.settings = {
      ...state.settings,
      apiKey: key,
      model: $('#fModel').value,
      temperature: Number($('#fTemp').value),
      maxTokens: Math.max(50, Number($('#fMaxTokens').value) || 800),
      contextMessages: Math.max(2, Number($('#fCtx').value) || 24),
      fontSize: Number($('#fFont').value) || 100,
      systemTemplate: $('#fPrompt').value.trim() === DEFAULT_PROMPT.trim() ? '' : $('#fPrompt').value
    };
    localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings));
    applyFont();
    renderHeader();
    el.settings.classList.remove('open');
    toast(key ? '设置已保存' : '已保存（还没填 API Key）');
  }

  function loadSettings() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}'); } catch { /* ignore */ }
    state.settings = { ...DEFAULT_SETTINGS, ...saved };
  }

  /* ------------------------------------------------ 小菜单 */

  let menuCleanup = null;
  let menuAnchor = null;

  function closeMenus() {
    el.ctxMenu.classList.remove('open');
    el.moreMenu.classList.remove('open');
    menuAnchor = null;
    if (menuCleanup) { menuCleanup(); menuCleanup = null; }
  }

  function showMenu(menu, anchor, items) {
    closeMenus();
    menuAnchor = anchor;
    menu.innerHTML = items.map((it) => it === '-' ? '<hr>' : `<button data-key="${it.key}" class="${it.danger ? 'danger' : ''}">${esc(it.label)}</button>`).join('');
    menu.classList.add('open');

    const rect = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let x = rect.right - mw;
    let y = rect.bottom + 6;
    x = Math.max(8, Math.min(x, window.innerWidth - mw - 8));
    if (y + mh > window.innerHeight - 8) y = Math.max(8, rect.top - mh - 6);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    const onClick = (e) => {
      const btn = e.target.closest('button[data-key]');
      if (!btn) return;
      const item = items.find((i) => i !== '-' && i.key === btn.dataset.key);
      closeMenus();
      if (item && item.onClick) item.onClick();
    };
    menu.addEventListener('click', onClick);

    const onDoc = (e) => {
      if (menu.contains(e.target)) return;
      if (anchor.contains(e.target)) return;
      closeMenus();
    };
    setTimeout(() => document.addEventListener('pointerdown', onDoc), 0);
    const onScroll = () => closeMenus();
    window.addEventListener('resize', onScroll, { once: true });

    menuCleanup = () => {
      menu.removeEventListener('click', onClick);
      document.removeEventListener('pointerdown', onDoc);
      window.removeEventListener('resize', onScroll);
    };
  }

  /* ------------------------------------------------ 输入框 */

  function autosize() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 180) + 'px';
  }

  const coarse = window.matchMedia('(pointer: coarse)').matches;

  /* ------------------------------------------------ 绑定事件 */

  function bind() {
    el.input.addEventListener('input', autosize);
    el.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse) {
        e.preventDefault();
        sendMessage();
      }
    });

    el.sendBtn.addEventListener('click', () => {
      if (state.streaming) {
        if (state.abortCtrl) state.abortCtrl.abort();
      } else {
        sendMessage();
      }
    });

    $('#btnMenu').addEventListener('click', toggleSidebar);
    $('#btnCloseSidebar').addEventListener('click', closeSidebar);
    el.overlay.addEventListener('click', () => { closeSidebar(); closeMenus(); });
    $('#btnNewChat').addEventListener('click', () => { closeSidebar(); openSetup(); });

    el.sessionList.addEventListener('click', (e) => {
      const more = e.target.closest('[data-more]');
      if (more) {
        e.stopPropagation();
        const id = more.dataset.more;
        const s = state.sessions.find((x) => x.id === id);
        if (!s) return;
        showMenu(el.ctxMenu, more, [
          { key: 'open', label: '打开', onClick: () => switchTo(id) },
          { key: 'rename', label: '重命名', onClick: () => renameSession(s) },
          { key: 'export', label: '导出', onClick: () => exportSession(s) },
          '-',
          { key: 'del', label: '删除', danger: true, onClick: () => removeSession(id) }
        ]);
        return;
      }
      const item = e.target.closest('.session-item');
      if (item) switchTo(item.dataset.id);
    });

    el.thoughtBtn.addEventListener('click', async () => {
      const s = cur();
      if (!s) return;
      s.showThoughts = s.showThoughts === false;
      if (s.showThoughts) state.peeked.clear();
      renderHeader();
      renderMessages();
      await persist(s);
    });

    el.lengthBtn?.addEventListener('click', (e) => {
      if (el.ctxMenu.classList.contains('open')) { closeMenus(); return; }
      const current = state.settings.lengthMode;
      const items = Object.entries(LENGTH_PRESETS).map(([key, p]) => ({
        key,
        label: `${current === key ? '✓ ' : '　'}${p.label} · ${p.hint || '用设置里的 token 上限'}`,
        onClick: () => setLength(key)
      }));
      showMenu(el.ctxMenu, e.currentTarget, items);
    });

    $('#btnMore').addEventListener('click', (e) => {
      const s = cur();
      if (!s) { toast('还没有对话'); return; }
      showMenu(el.moreMenu, e.currentTarget, [
        { key: 'copy', label: '复制完整设定', onClick: async () => {
          await copyText(sessionToText(s));
          toast('已复制到剪贴板');
        } },
        { key: 'edit', label: '编辑设定', onClick: () => openSetup(s) },
        { key: 'export', label: '导出这段对话', onClick: () => exportSession(s) },
        { key: 'kick', label: '让 TA 先开口', onClick: () => requestReply(s, '（请以角色的口吻自然地开场，描写当下的场景，然后说第一句话。）') },
        '-',
        { key: 'clear', label: '清空对话', danger: true, onClick: async () => {
          if (!(await askConfirm('清空所有消息？', '设定会保留，对话记录全部删除。', '清空'))) return;
          s.messages = [];
          renderAll();
          await persist(s);
        } },
        { key: 'del', label: '删除这段对话', danger: true, onClick: () => removeSession(s.id) }
      ]);
    });

    el.messages.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const msgEl = e.target.closest('.msg');
      const id = msgEl ? msgEl.dataset.id : null;
      const act = btn.dataset.act;

      if (act === 'new-session') { openSetup(); return; }

      const s = cur();
      if (!s) return;

      if (act === 'kickoff') {
        await requestReply(s, '（请以角色的口吻自然地开场，描写当下的场景，然后说第一句话。）');
        return;
      }
      if (act === 'peek') {
        if (state.peeked.has(id)) state.peeked.delete(id);
        else if (id) state.peeked.add(id);
        renderMessages();
        return;
      }
      if (act === 'copy') {
        const m = s.messages.find((x) => x.id === id);
        if (!m) return;
        await copyText(parseSegments(m.content).filter((x) => x.type === 'text').map((x) => x.text).join('\n').trim() || m.content);
        toast('已复制');
        return;
      }
      if (act === 'edit') { startEdit(id); return; }
      if (act === 'del') { await deleteMessage(id); return; }
      if (act === 'regen') { await regenerate(); return; }
      if (act === 'retry') {
        const idx = s.messages.findIndex((x) => x.id === id);
        if (idx >= 0) s.messages.splice(idx, 1);
        renderMessages();
        await requestReply(s);
        return;
      }
      if (act === 'cancel-edit') {
        state.editingId = null;
        renderMessages();
        return;
      }
      if (act === 'save-edit') { await saveEdit(id); return; }
    });

    el.messages.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.editingId) {
        state.editingId = null;
        renderMessages();
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target.matches('[data-edit-input]')) {
        e.preventDefault();
        saveEdit(e.target.dataset.editInput);
      }
    });

    // 设定弹窗
    $('#btnSetupStart').addEventListener('click', submitSetup);
    $('#btnSetupCancel').addEventListener('click', () => closeSetup());
    $('#btnSetupX').addEventListener('click', () => closeSetup());
    el.setup.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeSetup();
    });

    // 设置弹窗
    $('#btnSettings').addEventListener('click', () => { closeSidebar(); openSettings(); });
    $('#btnSettingsClose').addEventListener('click', () => el.settings.classList.remove('open'));
    $('#btnSettingsSave').addEventListener('click', saveSettings);
    $('#btnToggleKey').addEventListener('click', () => {
      const f = $('#fKey');
      f.type = f.type === 'password' ? 'text' : 'password';
      $('#btnToggleKey').textContent = f.type === 'password' ? '显示' : '隐藏';
    });
    $('#fTemp').addEventListener('input', (e) => { $('#tempVal').textContent = Number(e.target.value).toFixed(1); });
    $('#fFont').addEventListener('input', (e) => {
      $('#fontVal').textContent = e.target.value + '%';
      document.documentElement.style.setProperty('--scale', (Number(e.target.value) / 100).toFixed(3));
    });
    $('#btnResetPrompt').addEventListener('click', () => { $('#fPrompt').value = DEFAULT_PROMPT; });

    // 确认弹窗
    $('#btnConfirmYes').addEventListener('click', () => settleConfirm(true));
    $('#btnConfirmNo').addEventListener('click', () => settleConfirm(false));
    el.confirm.addEventListener('click', (e) => { if (e.target === el.confirm) settleConfirm(false); });

    // 导入
    $('#btnImport').addEventListener('click', () => el.fileImport.click());
    el.fileImport.addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) await importFile(f);
      e.target.value = '';
    });

    // 全局
    document.addEventListener('click', (e) => {
      if (menuAnchor && menuAnchor.contains(e.target)) return;
      if (e.target.closest('.ctx-menu')) return;
      closeMenus();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeMenus();
        if (el.confirm.classList.contains('open')) settleConfirm(false);
      }
      if (e.key === 'k' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
        e.preventDefault();
        openSidebar();
      }
    });
  }

  async function renameSession(s) {
    const name = window.prompt('新的名字', s.title || s.charName);
    if (name === null) return;
    const v = name.trim();
    if (!v) return;
    s.title = v;
    s.updatedAt = now();
    await Store.put(s);
    renderAll();
  }

  /* ------------------------------------------------ 启动 */

  async function init() {
    loadSettings();
    applyFont();
    try {
      if (!isMobile() && localStorage.getItem('rp.sidebarCollapsed') === '1') {
        el.app.classList.add('collapsed');
      }
    } catch { /* ignore */ }
    state.sessions = await Store.all();
    // 旧存档迁移：心理描写改为默认收起
    for (const s of state.sessions) {
      if (!s.thoughtV2) {
        s.showThoughts = false;
        s.thoughtV2 = true;
        try { await Store.put(s); } catch { /* ignore */ }
      }
    }
    state.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (state.sessions.length) state.currentId = state.sessions[0].id;

    bind();
    renderAll();
    setSending(false);
    autosize();

    if (!state.currentId) {
      openSetup();
    } else {
      scrollBottom(true);
      if (!state.settings.apiKey) toast('还没填 API Key，点左下角「设置」');
    }
  }

  init().catch((err) => {
    console.error('[roleplay] 初始化失败', err);
    const box = document.getElementById('messages');
    if (box) {
      box.innerHTML = '<div class="messages-inner"><div class="empty-state">' +
        '<h2>页面加载出错</h2><p>按 Ctrl + F5 强制刷新试试；<br>还不行的话，打开控制台把报错发我。</p></div></div>';
    }
  });
})();
