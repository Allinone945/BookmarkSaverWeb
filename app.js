/**
 * BookmarkSaver - Popup 主程式
 *
 * 功能 (依 Edge.md v2.4 規格)：
 *  - 記錄當前網頁 URL + Title (同網址不重複)
 *  - ★ 星號 = 置頂分類；✕ 刪除 (可復原)
 *  - ❤ 愛心 → 移至收藏區 (從主清單/封存區消失，取消後回到原處)
 *  - 📦 封存 / 🔙 取消封存
 *  - 時間軸分類：置頂 / 今天 / 昨天 / 一週內 / 一個月內 / 超過一個月 (皆以時間新→舊排序)
 *  - 打開時自動從 Dropbox 下載；任何變更自動上傳 (由 background.js 執行)
 */
(() => {
  'use strict';

  const { DEFAULT_FILE_PATH, generateId, getTimestamp, normalizeLinks, normalizePath } = self.BookmarkShared;

  const DAY = 24 * 60 * 60 * 1000;
  const VIEWS = ['main', 'favorite', 'archive', 'topic'];
  const VIEW_LABEL = { main: '主清單', favorite: '收藏區', archive: '封存區', topic: '主題區' };
  const EMPTY_TEXT = {
    main: { icon: '#i-bookmark', title: '主清單是空的', desc: '點擊上方「記錄當前網頁」開始收藏吧！' },
    topic: { icon: '#i-tag', title: '還沒有主題', desc: '使用上方的新增主題按鈕，或是在書籤上點擊標籤圖示！' },
    favorite: { icon: '#i-heart', title: '還沒有收藏', desc: '在任何連結點一下愛心，它就會移到這裡。' },
    archive: { icon: '#i-archive', title: '封存區是空的', desc: '暫時用不到的連結可以封存，主清單會更清爽。' }
  };
  const META_URL = 'bookmarksaver://metadata';

  const $ = (id) => document.getElementById(id);
  const els = {
    syncStatus: $('syncStatus'),
    syncStatusText: $('syncStatusText'),
    settingsBtn: $('settingsBtn'),
    settingsPanel: $('settingsPanel'),
    appKey: $('dbxAppKey'),
    appSecret: $('dbxAppSecret'),
    refreshToken: $('dbxRefreshToken'),
    filePath: $('dbxFilePath'),
    saveTokenBtn: $('saveTokenBtn'),
    syncUpBtn: $('syncUpBtn'),
    syncDownBtn: $('syncDownBtn'),
    exportJsonBtn: $('exportJsonBtn'),
    importJsonInput: $('importJsonInput'),
    lastSyncText: $('lastSyncText'),
    addUrlInput: $('addUrlInput'),
    addTitleInput: $('addTitleInput'),
    addBtn: $('addCurrentBtn'),
    searchInput: $('searchInput'),
    tabs: document.querySelector('.tabs'),
    tabButtons: Array.from(document.querySelectorAll('.tab')),
    counts: { main: $('mainCount'), topic: $('topicCount'), favorite: $('favoriteCount'), archive: $('archiveCount') },
    linkList: $('linkList'),
    topicActions: $('topicActions'),
    createTagBtn: $('createTagBtn'),
    tagModal: $('tagModal'),
    tagCheckboxes: $('tagCheckboxes'),
    newTagInput: $('newTagInput'),
    tagCancelBtn: $('tagCancelBtn'),
    openFilterBtn: $('openFilterBtn'),
    filterModal: $('filterModal'),
    filterCheckboxes: $('filterCheckboxes'),
    filterCancelBtn: $('filterCancelBtn'),
    filterSaveBtn: $('filterSaveBtn'),
    groupContextMenu: $('groupContextMenu'),
    collapseAllBtn: $('collapseAllBtn'),
    expandAllBtn: $('expandAllBtn'),
    archiveAllBtn: $('archiveAllBtn'),
    listContainer: $('listContainer'),
    emptyState: $('emptyState'),
    emptyIconUse: $('emptyIconUse'),
    emptyTitle: $('emptyTitle'),
    emptyDesc: $('emptyDesc'),
    footerTotal: $('footerTotal'),
    footerSync: $('footerSync'),
    toast: $('toast'),
    toastText: $('toastText'),
    toastAction: $('toastAction')
  };

  const state = {
    links: [],
    view: 'main',
    version: 0,          // 每次本機變更 +1，用來偵測「下載途中使用者有修改」
    uploadReq: 0,        // 只顯示最後一次上傳的結果
    currentTab: null,
    searchQuery: '',
    lastSyncAt: null,
    configured: false,
    collapsedGroups: new Set(),
    filteredTags: null
  };

  init();

  // =========================================================================
  // 初始化
  // =========================================================================

  async function init() {
    bindEvents();

    const store = JSON.parse(localStorage.getItem('BookmarkSaverStore') || '{}');

    state.links = normalizeLinks(store.savedLinks || []);
    state.lastSyncAt = store.lastSyncAt || null;
    els.appKey.value = store.dbxAppKey || '';
    els.appSecret.value = store.dbxAppSecret || '';
    els.refreshToken.value = store.dbxRefreshToken || '';
    els.filePath.value = store.dbxFilePath || DEFAULT_FILE_PATH;
    state.configured = !!(store.dbxAppKey && store.dbxAppSecret && store.dbxRefreshToken);

    state.currentTab = null;

    render({ animate: true });

    if (state.configured) {
      syncDown({ mode: 'replace' });
    } else {
      setStatus('offline', '未連線', '尚未設定 Dropbox 金鑰，資料僅存在本機');
      if (state.links.length === 0) openSettings();
    }
  }

  function bindEvents() {
    els.settingsBtn.addEventListener('click', toggleSettings);
    els.syncStatus.addEventListener('click', () => {
      if (!state.configured) openSettings();
      else syncDown({ mode: 'replace', manual: true });
    });

    els.saveTokenBtn.addEventListener('click', saveSettings);
    els.syncUpBtn.addEventListener('click', () => requestUpload({ manual: true }));
    els.syncDownBtn.addEventListener('click', () => syncDown({ mode: 'replace', manual: true }));
    els.exportJsonBtn.addEventListener('click', exportJson);
    els.importJsonInput.addEventListener('change', importJson);

    els.searchInput.addEventListener('input', (e) => {
      state.searchQuery = e.target.value.trim().toLowerCase();
      render({ animate: false });
    });

    els.createTagBtn.addEventListener('click', () => {
      const name = prompt('請輸入新主題名稱：');
      if (name && name.trim()) {
        const tags = getTags();
        if (!tags.includes(name.trim())) {
          tags.push(name.trim());
          saveTags(tags);
          if (state.view === 'topic') render({ animate: true });
        }
      }
    });

    // bundle logic removed

    els.tagCancelBtn.addEventListener('click', closeTagModal);
    els.newTagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addNewTagFromModal();
    });

    els.openFilterBtn.addEventListener('click', openFilterModal);
    els.filterCancelBtn.addEventListener('click', closeFilterModal);
    els.filterSaveBtn.addEventListener('click', saveFilter);

    els.collapseAllBtn.addEventListener('click', collapseAll);
    els.expandAllBtn.addEventListener('click', expandAll);
    els.archiveAllBtn.addEventListener('click', archiveAllInGroup);
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#groupContextMenu')) {
        els.groupContextMenu.hidden = true;
      }
    });

    [els.appKey, els.appSecret, els.refreshToken, els.filePath].forEach((input) => {
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSettings(); });
    });

    document.querySelectorAll('.reveal-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = $(btn.dataset.target);
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.classList.toggle('on', show);
      });
    });

    els.addBtn.addEventListener('click', addCurrentPage);
    els.tabButtons.forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.view)));

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !els.settingsPanel.hidden) {
        e.preventDefault();
        closeSettings();
      }
    });
  }

  // =========================================================================
  // 設定面板
  // =========================================================================

  function openSettings() {
    els.settingsPanel.hidden = false;
    els.settingsBtn.setAttribute('aria-expanded', 'true');
    updateLastSyncText();
    const firstEmpty = [els.appKey, els.appSecret, els.refreshToken].find((i) => !i.value);
    if (firstEmpty) firstEmpty.focus();
  }

  function closeSettings() {
    els.settingsPanel.hidden = true;
    els.settingsBtn.setAttribute('aria-expanded', 'false');
  }

  function toggleSettings() {
    if (els.settingsPanel.hidden) openSettings();
    else closeSettings();
  }

  async function saveSettings() {
    const cfg = {
      dbxAppKey: els.appKey.value.trim(),
      dbxAppSecret: els.appSecret.value.trim(),
      dbxRefreshToken: els.refreshToken.value.trim(),
      dbxFilePath: normalizePath(els.filePath.value)
    };
    if (!cfg.dbxAppKey || !cfg.dbxAppSecret || !cfg.dbxRefreshToken) {
      toast('請完整填寫 App Key、App Secret 與 Refresh Token', 'error');
      return;
    }
    els.filePath.value = cfg.dbxFilePath;

    setBusy(els.saveTokenBtn, true);
    
    const store = JSON.parse(localStorage.getItem('BookmarkSaverStore') || '{}');
    Object.assign(store, cfg);
    localStorage.setItem('BookmarkSaverStore', JSON.stringify(store));
    sessionStorage.removeItem('dbxTokenCache'); // Clear token cache
    state.configured = true;
    
    const ok = await syncDown({ mode: 'merge', manual: true });
    setBusy(els.saveTokenBtn, false);

    if (ok) closeSettings();
  }

  function setBusy(btn, busy) {
    btn.classList.toggle('is-busy', busy);
    btn.disabled = busy;
  }

  // =========================================================================
  // 同步 (實際 API 呼叫在 background.js)
  // =========================================================================

  // (chrome.runtime.sendMessage 移除，改由本地 API 直接處理)

  const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
  const UPLOAD_URL = 'https://content.dropboxapi.com/2/files/upload';
  const DOWNLOAD_URL = 'https://content.dropboxapi.com/2/files/download';

  async function getAccessToken(forceRefresh = false) {
    const store = JSON.parse(localStorage.getItem('BookmarkSaverStore') || '{}');
    if (!store.dbxAppKey || !store.dbxAppSecret || !store.dbxRefreshToken) {
      throw new Error('尚未設定 Dropbox 同步金鑰');
    }
    const cache = JSON.parse(sessionStorage.getItem('dbxTokenCache') || 'null');
    if (!forceRefresh && cache && cache.token && cache.expiresAt - 60000 > Date.now()) {
      return cache.token;
    }
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + btoa(store.dbxAppKey + ':' + store.dbxAppSecret)
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: store.dbxRefreshToken })
    });
    const data = await response.json();
    if (!response.ok || !data.access_token) throw new Error(`Token 換發失敗`);
    sessionStorage.setItem('dbxTokenCache', JSON.stringify({ token: data.access_token, expiresAt: Date.now() + (data.expires_in || 14400) * 1000 }));
    return data.access_token;
  }

  async function syncDown({ mode = 'replace', manual = false } = {}) {
    const startVersion = state.version;
    setStatus('syncing', manual ? '下載中…' : '檢查雲端…');

    try {
      const token = await getAccessToken();
      const store = JSON.parse(localStorage.getItem('BookmarkSaverStore') || '{}');
      const apiArg = JSON.stringify({ path: normalizePath(store.dbxFilePath) })
        .replace(/[\\u007F-\\uFFFF]/g, chr => '\\u' + ('0000' + chr.charCodeAt(0).toString(16)).slice(-4));
      
      const res = await fetch(DOWNLOAD_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Dropbox-API-Arg': apiArg }
      });
      
      let resData = { ok: true, links: [] };
      if (res.status === 409) {
        resData.notFound = true;
      } else if (!res.ok) {
        throw new Error('下載失敗 HTTP ' + res.status);
      } else {
        const json = await res.json();
        resData.links = normalizeLinks(json);
      }

      if (resData.notFound) {
        if (state.links.length > 0) {
          if (manual) toast(`雲端尚無資料，已用本機資料建立`, 'info');
          await requestUpload({ manual: false });
        } else {
          markSynced(Date.now(), '已連線');
          if (manual) toast(`已連線！雲端將建立檔案`, 'success');
        }
        return true;
      }

      // 下載途中使用者有修改 → 以本機為準並上傳，避免覆蓋掉剛剛的操作
      if (!manual && state.version !== startVersion) {
        await requestUpload();
        return true;
      }

      let next = resData.links;
      let mergedCount = 0;
    if (mode === 'merge') {
      const remoteUrls = new Set(next.map((l) => l.url));
      const localOnly = state.links.filter((l) => !remoteUrls.has(l.url));
      mergedCount = localOnly.length;
      next = next.concat(localOnly);
    }

    const changed = JSON.stringify(next) !== JSON.stringify(state.links);
    state.links = next;
    if (changed) {
      state.version++;
      await chrome.storage.local.set({ savedLinks: state.links });
      render();
    }
    markSynced(res.syncedAt);

    if (mergedCount > 0) {
      await requestUpload();
      toast(`已同步，並將本機 ${mergedCount} 筆連結合併至雲端`, 'success');
    } else if (manual) {
      toast(`已從 Dropbox 載入 ${next.length} 筆連結`, 'success');
    }
    return true;
  }

  async function requestUpload({ manual = false } = {}) {
    const req = ++state.uploadReq;
    setStatus('syncing', '上傳中…');

    const res = await send({ type: 'upload' });
    if (req !== state.uploadReq) return res.ok; // 已有更新的上傳請求

    if (!res.ok) {
      handleSyncError(res, manual);
      return false;
    }
    if (!res.skipped) markSynced(res.syncedAt);
    if (manual) toast(`已上傳 ${state.links.length} 筆連結到 Dropbox`, 'success');
    return true;
  }

  function handleSyncError(res, manual) {
    if (res.code === 'NO_CONFIG') {
      state.configured = false;
      setStatus('offline', '未連線', '尚未設定 Dropbox 金鑰，資料僅存在本機');
      if (manual) {
        toast('請先填寫 Dropbox 同步金鑰', 'warn');
        openSettings();
      }
      return;
    }
    setStatus('error', '同步失敗', res.error);
    if (manual || res.code === 'AUTH') toast(res.error, 'error', { duration: 6000 });
  }

  function exportJson() {
    const data = JSON.stringify(state.links, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `BookmarkSaver_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('已匯出 JSON 備份', 'success');
  }

  async function importJson(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error('檔案格式錯誤，必須為 JSON 陣列');
      const normalized = normalizeLinks(parsed);

      const remoteUrls = new Set(state.links.map(l => l.url));
      const newLinks = normalized.filter(l => !remoteUrls.has(l.url));

      if (newLinks.length > 0) {
        state.links = state.links.concat(newLinks);
        await persist();
        toast(`成功匯入 ${newLinks.length} 筆新連結`, 'success');
      } else {
        toast('沒有發現新連結', 'info');
      }
    } catch (err) {
      toast('匯入失敗：' + err.message, 'error');
    } finally {
      e.target.value = '';
    }
  }

  function markSynced(syncedAt, label = '已同步') {
    state.lastSyncAt = syncedAt || Date.now();
    setStatus('ok', label, `上次同步：${formatFullTime(state.lastSyncAt)}`);
    updateFooter();
    updateLastSyncText();
  }

  function setStatus(kind, text, detail) {
    els.syncStatus.dataset.state = kind;
    els.syncStatusText.textContent = text;
    els.syncStatus.title = detail || text;
  }

  function updateLastSyncText() {
    els.lastSyncText.textContent = state.lastSyncAt
      ? `上次同步：${formatFullTime(state.lastSyncAt)}`
      : '尚未與 Dropbox 同步';
  }

  // =========================================================================
  // 資料操作
  // =========================================================================

  function getTags() {
    const meta = state.links.find(l => l.url === META_URL);
    return meta && Array.isArray(meta.tags) ? meta.tags : [];
  }

  function saveTags(tags) {
    let meta = state.links.find(l => l.url === META_URL);
    if (!meta) {
      meta = { id: generateId(), url: META_URL, title: 'BookmarkSaver Metadata', tags: [], isArchived: true, isHearted: false, isStarred: false, createdAt: 0 };
      state.links.push(meta);
    }
    meta.tags = tags;
    persist();
  }

  async function persist() {
    state.version++;
    const store = JSON.parse(localStorage.getItem('BookmarkSaverStore') || '{}');
    store.savedLinks = state.links;
    localStorage.setItem('BookmarkSaverStore', JSON.stringify(store));
    render();
    if (state.configured) requestUpload();
    else updateFooter();
  }

  function findLink(id) {
    return state.links.find((l) => l.id === id);
  }

  function viewOf(link) {
    if (link.isHearted) return 'favorite';
    if (link.isArchived) return 'archive';
    if (link.isHiddenFromMain) return 'none';
    return 'main';
  }

  function inView(link, view) {
    if (view === 'topic') return !link.isArchived;
    return viewOf(link) === view;
  }

  async function addCurrentPage() {
    const url = els.addUrlInput.value.trim();
    const title = els.addTitleInput.value.trim();
    if (!url) {
      toast('請貼上網址', 'error');
      return;
    }

    const existing = state.links.find((l) => l.url === url);
    if (existing) {
      if (existing.isHiddenFromMain) {
        existing.isHiddenFromMain = false;
        persist();
      }
      const where = viewOf(existing);
      if (where !== state.view) switchView(where);
      toast(`這個網頁已經在「${VIEW_LABEL[where]}」中了！`, 'info');
      flash(existing.id);
      return;
    }

    const now = Date.now();
    const link = {
      id: generateId(),
      createdAt: now,
      title: title || url,
      url: url,
      isStarred: false,
      isArchived: false,
      isHearted: false,
      isHiddenFromMain: false
    };
    state.links.push(link);
    els.addUrlInput.value = '';
    els.addTitleInput.value = '';
    if (state.view !== 'main') switchView('main', { skipRender: true });
    await persist();

    els.addBtn.classList.remove('success');
    void els.addBtn.offsetWidth; 
    els.addBtn.classList.add('success');
    flash(link.id);
  }

  /** 修改單筆連結；若修改後不屬於目前分頁，先播放離場動畫 */
  async function mutate(id, li, change) {
    const link = findLink(id);
    if (!link || (li && li.dataset.busy)) return null;
    change(link);
    if (li && !inView(link, state.view)) {
      li.dataset.busy = '1';
      li.classList.add('leaving');
      await wait(190);
    }
    await persist();
    return link;
  }

  async function toggleStar(id, li) {
    const link = await mutate(id, li, (l) => { l.isStarred = !l.isStarred; });
    if (link) flash(id, { pop: 'star' });
  }

  async function toggleHeart(id, li) {
    const link = await mutate(id, li, (l) => { l.isHearted = !l.isHearted; });
    if (!link) return;
    if (link.isHearted) toast('已加入收藏區', 'success');
    else if (state.view === 'favorite') toast(`已取消收藏，移回${VIEW_LABEL[viewOf(link)]}`, 'info');
  }

  async function toggleArchive(id, li) {
    const link = await mutate(id, li, (l) => { l.isArchived = !l.isArchived; });
    if (!link) return;
    if (state.view === 'favorite') {
      toast(link.isArchived ? '已標記為封存 (取消收藏後會出現在封存區)' : '已取消封存', 'info');
    } else {
      toast(link.isArchived ? '已封存' : '已移回主清單', 'success');
    }
  }

  async function deleteLink(id, li) {
    const index = state.links.findIndex((l) => l.id === id);
    if (index < 0 || (li && li.dataset.busy)) return;
    const target = state.links[index];

    if (state.view === 'main' && target.tags && target.tags.length > 0) {
      if (li) {
        li.dataset.busy = '1';
        li.classList.add('leaving');
        await wait(190);
      }
      target.isHiddenFromMain = true;
      await persist();
      toast(`已從主清單移除，仍保留於主題區`, 'info', {
        actionLabel: '復原',
        duration: 5000,
        onAction: async () => {
          target.isHiddenFromMain = false;
          await persist();
          const where = viewOf(target);
          if (where !== state.view) switchView(where, { skipRender: true });
          flash(target.id);
        }
      });
      return;
    }

    const removed = state.links[index];
    if (li) {
      li.dataset.busy = '1';
      li.classList.add('leaving');
      await wait(190);
    }
    state.links.splice(index, 1);
    await persist();

    toast(`已刪除「${truncate(removed.title, 18)}」`, 'info', {
      actionLabel: '復原',
      duration: 5000,
      onAction: async () => {
        if (state.links.some((l) => l.url === removed.url)) return;
        state.links.splice(Math.min(index, state.links.length), 0, removed);
        const where = viewOf(removed);
        if (where !== state.view) switchView(where, { skipRender: true });
        await persist();
        flash(removed.id);
      }
    });
  }

  // =========================================================================
  // 畫面
  // =========================================================================

  function switchView(view, { skipRender = false } = {}) {
    if (!VIEWS.includes(view)) return;
    state.view = view;
    if (view === 'topic') {
      state.collapsedGroups.clear();
      getTags().forEach(t => state.collapsedGroups.add(t));
      state.collapsedGroups.add('未分類');
    }
    els.topicActions.hidden = view !== 'topic';
    els.tabs.dataset.active = String(VIEWS.indexOf(view));
    els.tabButtons.forEach((btn) => {
      const active = btn.dataset.view === view;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    els.listContainer.scrollTop = 0;
    if (!skipRender) render({ animate: true });
  }

  function render({ animate = false } = {}) {
    updateCounts();
    updateAddButton();
    updateFooter();

    const query = state.searchQuery;
    const items = state.links
      .filter((l) => l.url !== META_URL && inView(l, state.view) && (!query || l.title.toLowerCase().includes(query) || l.url.toLowerCase().includes(query)))
      .sort((a, b) => getTimestamp(b) - getTimestamp(a));

    els.linkList.classList.toggle('animate', animate);
    els.linkList.replaceChildren();

    if (items.length === 0) {
      const empty = EMPTY_TEXT[state.view];
      els.emptyIconUse.setAttribute('href', empty.icon);
      els.emptyTitle.textContent = empty.title;
      els.emptyDesc.textContent = empty.desc;
      els.emptyState.hidden = false;
      return;
    }
    els.emptyState.hidden = true;

    const frag = document.createDocumentFragment();
    let index = 0;
    for (const group of groupLinks(items)) {
      if (group.items.length === 0 && !group.isTag) continue;
      if (group.isTag && group.items.length === 0 && state.filteredTags) continue; // Hide empty tags if filtering is active (or maybe we just hide empty tags altogether)
      if (group.items.length === 0 && !group.isTag) continue; 
      // Actually just:
      if (group.items.length === 0 && !group.isTag) continue;

      const header = createGroupHeader(group);
      if (animate) header.style.animationDelay = `${Math.min(index, 14) * 16}ms`;
      frag.appendChild(header);
      
      if (!state.collapsedGroups.has(group.title)) {
        for (const link of group.items) {
          const li = createItem(link);
          if (animate) li.style.animationDelay = `${Math.min(index++, 14) * 16}ms`;
          frag.appendChild(li);
        }
      }
    }
    els.linkList.appendChild(frag);
  }

  /** 依規格分類：置頂 > 今天 > 昨天 > 一週內 > 一個月內 > 超過一個月 (items 已依時間排序) */
  function groupLinks(items) {
    if (state.view === 'topic' || state.view === 'archive') {
      const allTags = getTags();
      let groups = allTags.map(tag => ({ key: 'tag', title: tag, items: [], isTag: true }));
      const untagged = { key: 'untagged', title: '未分類', items: [], isTag: false };
      for (const link of items) {
        let hasTag = false;
        if (Array.isArray(link.tags)) {
          for (const t of link.tags) {
            const g = groups.find(x => x.title === t);
            if (g) { g.items.push(link); hasTag = true; }
          }
        }
        if (!hasTag) untagged.items.push(link);
      }
      if (untagged.items.length > 0) groups.push(untagged);

      if (state.filteredTags) {
        groups = groups.filter(g => g.isTag === false || state.filteredTags.has(g.title));
      }
      return groups;
    }

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfYesterday = startOfToday - DAY;
    const startOfWeek = startOfToday - 6 * DAY;    // 含今天共 7 天
    const startOfMonth = startOfToday - 29 * DAY;  // 含今天共 30 天

    const groups = [
      { key: 'pinned', title: '置頂', items: [] },
      { key: 'today', title: '今天', items: [] },
      { key: 'yesterday', title: '昨天', items: [] },
      { key: 'week', title: '一週內', items: [] },
      { key: 'month', title: '一個月內', items: [] },
      { key: 'older', title: '超過一個月', items: [] }
    ];
    const [pinned, today, yesterday, week, month, older] = groups;

    for (const link of items) {
      const ts = getTimestamp(link);
      if (link.isStarred) pinned.items.push(link);
      else if (ts >= startOfToday) today.items.push(link);
      else if (ts >= startOfYesterday) yesterday.items.push(link);
      else if (ts >= startOfWeek) week.items.push(link);
      else if (ts >= startOfMonth) month.items.push(link);
      else older.items.push(link);
    }
    return groups;
  }

  function createGroupHeader(group) {
    const li = el('li', `group-header ${group.key}`);
    li.setAttribute('role', 'presentation');

    const isCollapsed = state.collapsedGroups.has(group.title);
    const toggleBtn = el('button', 'gh-toggle');
    toggleBtn.innerHTML = isCollapsed ? '<svg class="i"><use href="#i-chevron-right"/></svg>' : '<svg class="i"><use href="#i-chevron-down"/></svg>';
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isCollapsed) state.collapsedGroups.delete(group.title);
      else state.collapsedGroups.add(group.title);
      render({ animate: false });
    });
    li.appendChild(toggleBtn);

    if (group.key === 'pinned') li.appendChild(icon('#i-star'));
    else if (group.isTag) li.appendChild(icon('#i-tag'));

    li.appendChild(el('span', '', group.title));
    li.appendChild(el('span', 'g-count', String(group.items.length)));

    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      els.archiveAllBtn.hidden = state.view !== 'topic';
      els.groupContextMenu.dataset.targetGroup = group.title;
      els.groupContextMenu.style.left = `${e.clientX}px`;
      els.groupContextMenu.style.top = `${e.clientY}px`;
      els.groupContextMenu.hidden = false;
    });

    if (group.isTag) {
      const acts = el('div', 'gh-acts');
      const editBtn = el('button', 'gh-act');
      editBtn.title = '重新命名';
      editBtn.textContent = '✎';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const newName = prompt('請輸入新的主題名稱：', group.title);
        if (newName && newName.trim() && newName.trim() !== group.title) {
          const tags = getTags();
          const idx = tags.indexOf(group.title);
          if (idx >= 0) {
            tags[idx] = newName.trim();
            saveTags(tags);
            state.links.forEach(l => {
              if (Array.isArray(l.tags)) {
                const ti = l.tags.indexOf(group.title);
                if (ti >= 0) { l.tags[ti] = newName.trim(); }
              }
            });
            if (state.collapsedGroups.has(group.title)) {
              state.collapsedGroups.delete(group.title);
              state.collapsedGroups.add(newName.trim());
            }
            if (state.filteredTags && state.filteredTags.has(group.title)) {
              state.filteredTags.delete(group.title);
              state.filteredTags.add(newName.trim());
            }
            persist();
          }
        }
      });
      const delBtn = el('button', 'gh-act');
      delBtn.title = '刪除主題';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`確定要刪除主題「${group.title}」嗎？這不會刪除書籤，只會移除它們的標籤。`)) {
          const tags = getTags();
          saveTags(tags.filter(t => t !== group.title));
          state.links.forEach(l => {
            if (Array.isArray(l.tags)) { l.tags = l.tags.filter(t => t !== group.title); }
          });
          if (state.filteredTags) state.filteredTags.delete(group.title);
          persist();
        }
      });
      acts.append(editBtn, delBtn);
      li.appendChild(acts);
    }
    return li;
  }

  function createItem(link) {
    const li = el('li', 'link-item' + (link.isStarred ? ' starred' : ''));
    li.dataset.id = link.id;

    const a = el('a', 'link-body');
    const href = safeHref(link.url);
    if (href) {
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    a.title = `${link.title}\n${link.url}`;
    a.appendChild(el('span', 'link-title', link.title));
    a.appendChild(el('span', 'link-meta', `${hostOf(link.url)} · ${formatTime(getTimestamp(link))}`));

    const actions = el('div', 'actions');
    const hasTag = Array.isArray(link.tags) && link.tags.length > 0;
    actions.append(
      actionButton('star', link.isStarred, link.isStarred ? '取消置頂' : '標示為重要 (置頂)', '#i-star',
        () => toggleStar(link.id, li)),
      actionButton('heart', link.isHearted, link.isHearted ? '取消收藏' : '加入收藏', '#i-heart',
        () => toggleHeart(link.id, li)),
      actionButton('tag', hasTag, '設定主題', '#i-tag', () => openTagModal(link)),
      actionButton('archive', false, link.isArchived ? '取消封存，移回主清單' : '封存此連結',
        link.isArchived ? '#i-unarchive' : '#i-archive', () => toggleArchive(link.id, li)),
      actionButton('del', false, '刪除', '#i-x', () => deleteLink(link.id, li))
    );

    li.append(createFavicon(link.url), a, actions);
    return li;
  }

  function actionButton(kind, active, label, iconId, onClick) {
    const btn = el('button', `act ${kind}${active ? ' is-active' : ''}`);
    btn.type = 'button';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', String(!!active));
    btn.appendChild(icon(iconId));
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  function createFavicon(url) {
    const wrap = el('div', 'favicon');
    const host = hostOf(url);
    const fallback = () => {
      wrap.replaceChildren();
      wrap.classList.add('letter');
      wrap.style.background = `linear-gradient(135deg, hsl(${hueOf(host)} 70% 55%), hsl(${(hueOf(host) + 40) % 360} 75% 45%))`;
      wrap.textContent = (host.replace(/[^a-z0-9\u4e00-\u9fff]/gi, '')[0] || '#').toUpperCase();
    };

    if (/^https?:/i.test(url)) {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', fallback, { once: true });
      img.src = `https://www.google.com/s2/favicons?domain=${host}&sz=32`;
      wrap.appendChild(img);
    } else {
      fallback();
    }
    return wrap;
  }

  function updateCounts() {
    const counts = { main: 0, topic: 0, favorite: 0, archive: 0 };
    state.links.forEach((l) => {
      if (l.url === META_URL) return;
      counts[viewOf(l)]++;
      if (!l.isArchived) counts.topic++;
    });
    VIEWS.forEach((v) => { els.counts[v].textContent = String(counts[v]); });
  }

  function updateAddButton() {
    const tab = state.currentTab;
    const existing = tab && tab.url ? state.links.find((l) => l.url === tab.url) : null;
    els.addBtn.classList.toggle('is-saved', !!existing);
    els.addBtn.querySelector('use').setAttribute('href', existing ? '#i-check' : '#i-plus');
    if (existing) {
      els.addBtnLabel.textContent = `此頁已在${VIEW_LABEL[viewOf(existing)]}`;
      els.addBtnSub.textContent = '點擊前往查看';
    } else {
      els.addBtnLabel.textContent = '記錄當前網頁';
      els.addBtnSub.textContent = tab && tab.title ? tab.title : '';
    }
  }

  function updateFooter() {
    els.footerTotal.textContent = `共 ${state.links.length} 筆連結`;
    els.footerSync.textContent = state.configured
      ? (state.lastSyncAt ? `Dropbox · ${formatRelative(state.lastSyncAt)}同步` : 'Dropbox · 尚未同步')
      : '僅存於本機';
  }

  function flash(id, { pop } = {}) {
    requestAnimationFrame(() => {
      const li = els.linkList.querySelector(`.link-item[data-id="${CSS.escape(id)}"]`);
      if (!li) return;
      li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      li.classList.remove('flash');
      void li.offsetWidth;
      li.classList.add('flash');
      if (pop) {
        const btn = li.querySelector(`.act.${pop}`);
        if (btn) btn.classList.add('pop');
      }
    });
  }

  // =========================================================================
  // Toast
  // =========================================================================

  let toastTimer = null;
  let toastHandler = null;

  els.toastAction.addEventListener('click', () => {
    const handler = toastHandler;
    hideToast();
    if (handler) handler();
  });

  function toast(message, type = 'info', { actionLabel, onAction, duration = 2600 } = {}) {
    clearTimeout(toastTimer);
    els.toastText.textContent = message;
    els.toast.dataset.type = type;
    toastHandler = onAction || null;
    els.toastAction.hidden = !onAction;
    if (actionLabel) els.toastAction.textContent = actionLabel;

    // 重新播放進場動畫
    els.toast.hidden = true;
    void els.toast.offsetWidth;
    els.toast.hidden = false;
    toastTimer = setTimeout(hideToast, duration);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    els.toast.hidden = true;
    toastHandler = null;
  }

  // =========================================================================
  // Tag Modal
  // =========================================================================

  let currentTagLink = null;

  function openTagModal(link) {
    currentTagLink = link;
    renderTagCheckboxes();
    els.newTagInput.value = '';
    els.tagModal.hidden = false;
  }

  function closeTagModal() {
    els.tagModal.hidden = true;
    currentTagLink = null;
  }

  function renderTagCheckboxes() {
    const allTags = getTags();
    els.tagCheckboxes.replaceChildren();
    
    if (allTags.length === 0) {
      els.tagCheckboxes.textContent = '目前還沒有任何主題，請從下方新增。';
      els.tagCheckboxes.style.color = 'var(--text-3)';
      return;
    }
    els.tagCheckboxes.style.color = '';
    
    const frag = document.createDocumentFragment();
    for (const tag of allTags) {
      const pill = el('label', 'tag-pill');
      const isSelected = Array.isArray(currentTagLink.tags) && currentTagLink.tags.includes(tag);
      if (isSelected) pill.classList.add('selected');
      
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.hidden = true;
      cb.checked = isSelected;
      cb.addEventListener('change', () => {
        pill.classList.toggle('selected', cb.checked);
        updateLinkTag(tag, cb.checked);
      });
      
      pill.appendChild(cb);
      pill.appendChild(document.createTextNode(tag));
      frag.appendChild(pill);
    }
    els.tagCheckboxes.appendChild(frag);
  }

  function updateLinkTag(tag, add) {
    if (!currentTagLink) return;
    if (!Array.isArray(currentTagLink.tags)) currentTagLink.tags = [];
    const idx = currentTagLink.tags.indexOf(tag);
    if (add && idx < 0) currentTagLink.tags.push(tag);
    else if (!add && idx >= 0) currentTagLink.tags.splice(idx, 1);
    
    persist();
  }

  function addNewTagFromModal() {
    const name = els.newTagInput.value.trim();
    if (!name) return;
    const tags = getTags();
    if (!tags.includes(name)) {
      tags.push(name);
      saveTags(tags);
    }
    updateLinkTag(name, true);
    renderTagCheckboxes();
    els.newTagInput.value = '';
  }

  // =========================================================================
  // Bundle Modal
  // =========================================================================

  // Bundle Modal (Web 版已移除)

  // =========================================================================
  // Filter Modal
  // =========================================================================

  function openFilterModal() {
    const allTags = getTags();
    els.filterCheckboxes.replaceChildren();
    
    if (allTags.length === 0) {
      els.filterCheckboxes.textContent = '目前還沒有任何主題可以篩選。';
      els.filterCheckboxes.style.color = 'var(--text-3)';
    } else {
      els.filterCheckboxes.style.color = '';
      const frag = document.createDocumentFragment();
      for (const tag of allTags) {
        const pill = el('label', 'tag-pill');
        const isSelected = state.filteredTags ? state.filteredTags.has(tag) : false;
        if (isSelected) pill.classList.add('selected');
        
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.hidden = true;
        cb.checked = isSelected;
        cb.value = tag;
        cb.addEventListener('change', () => {
          pill.classList.toggle('selected', cb.checked);
        });
        
        pill.appendChild(cb);
        pill.appendChild(document.createTextNode(tag));
        frag.appendChild(pill);
      }
      els.filterCheckboxes.appendChild(frag);
    }
    
    els.filterModal.hidden = false;
  }

  function closeFilterModal() {
    els.filterModal.hidden = true;
  }

  function saveFilter() {
    const checkboxes = Array.from(els.filterCheckboxes.querySelectorAll('input[type="checkbox"]'));
    const allChecked = checkboxes.every(c => c.checked);
    const noneChecked = checkboxes.every(c => !c.checked);
    
    if (noneChecked) {
      state.filteredTags = null; // show all
    } else {
      const selected = checkboxes.filter(c => c.checked).map(c => c.value);
      state.filteredTags = new Set(selected);
    }
    
    closeFilterModal();
    render({ animate: true });
  }

  // =========================================================================
  // Context Menu Actions
  // =========================================================================

  function collapseAll() {
    if (state.view === 'topic') {
      getTags().forEach(t => state.collapsedGroups.add(t));
      state.collapsedGroups.add('未分類');
    } else {
      ['置頂', '今天', '昨天', '一週內', '一個月內', '超過一個月'].forEach(t => state.collapsedGroups.add(t));
    }
    els.groupContextMenu.hidden = true;
    render({ animate: false });
  }

  function expandAll() {
    state.collapsedGroups.clear();
    els.groupContextMenu.hidden = true;
    render({ animate: false });
  }

  function archiveAllInGroup() {
    const targetGroup = els.groupContextMenu.dataset.targetGroup;
    if (!targetGroup) return;
    
    let affected = 0;
    state.links.forEach(l => {
      if (!l.isArchived && inView(l, state.view)) {
        if (targetGroup === '未分類') {
          if (!l.tags || l.tags.length === 0) {
            l.isArchived = true;
            affected++;
          }
        } else {
          if (l.tags && l.tags.includes(targetGroup)) {
            l.isArchived = true;
            affected++;
          }
        }
      }
    });
    
    els.groupContextMenu.hidden = true;
    if (affected > 0) {
      persist();
      toast(`已將 ${affected} 個網址移至封存區`, 'success');
    }
  }

  // =========================================================================
  // 小工具
  // =========================================================================

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(id) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'i');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', id);
    svg.appendChild(use);
    return svg;
  }

  function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function safeHref(url) {
    try {
      const u = new URL(url);
      return /^(javascript|data|vbscript):$/i.test(u.protocol) ? '' : u.href;
    } catch (_) {
      return '';
    }
  }

  function hostOf(url) {
    try {
      const u = new URL(url);
      return (u.hostname || u.protocol.replace(':', '')).replace(/^www\./, '');
    } catch (_) {
      return url;
    }
  }

  function hueOf(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return h;
  }

  function truncate(str, n) {
    return str.length > n ? str.slice(0, n) + '…' : str;
  }

  const pad = (n) => String(n).padStart(2, '0');

  function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (ts >= startOfToday) return hm;
    if (ts >= startOfToday - DAY) return `昨天 ${hm}`;
    const year = d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()}/`;
    return `${year}${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  }

  function formatFullTime(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function formatRelative(ts) {
    const diff = Date.now() - ts;
    if (diff < 60 * 1000) return '剛剛';
    if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分鐘前`;
    if (diff < DAY) return `${Math.floor(diff / 3600000)} 小時前`;
    return `${Math.floor(diff / DAY)} 天前`;
  }
})();
