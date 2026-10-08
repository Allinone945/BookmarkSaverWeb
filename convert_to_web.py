import re

with open('app.js', 'r', encoding='utf-8') as f:
    js = f.read()

# 1. Replace elements
js = js.replace("addBtnLabel: addBtnLabel,\n    addBtnSub: addBtnSub,", "addUrlInput: addUrlInput,\n    addTitleInput: addTitleInput,")
js = re.sub(r"openBundleBtn:.*bundleSaveBtn: \$\('bundleSaveBtn'\),\n", "", js, flags=re.DOTALL)

# 2. Replace init storage
js = re.sub(r"const store = await chrome.storage.local.get.*?\]\);", "const store = JSON.parse(localStorage.getItem('BookmarkSaverStore') || '{}');", js, flags=re.DOTALL)

# 3. Replace chrome.tabs.query
js = re.sub(r"try \{\s+const \[tab\] = await chrome.tabs.query.*?\s+\} catch \(\_\) \{ /\* ignore \*/ \}", "", js, flags=re.DOTALL)

# 4. Replace persist
persist_func = '''
  async function persist() {
    state.version++;
    const store = JSON.parse(localStorage.getItem('BookmarkSaverStore') || '{}');
    store.savedLinks = state.links;
    store.lastSyncAt = state.lastSyncAt;
    localStorage.setItem('BookmarkSaverStore', JSON.stringify(store));
    render({ animate: false });
    requestUpload();
  }
'''
js = re.sub(r"async function persist\(\) \{.*?\n  \}", persist_func.strip(), js, flags=re.DOTALL)

# 5. replace addCurrentPage
add_func = '''
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
      toast(這個網頁已經在「\」中了！, 'info');
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
'''
js = re.sub(r"async function addCurrentPage\(\) \{.*?(?=  /\*\* 修改單筆連結)/s", add_func + "\n", js, flags=re.DOTALL)

# 6. Remove bundle events
js = re.sub(r"els.openBundleBtn.addEventListener.*?saveBundleTabs\);", "", js, flags=re.DOTALL)
js = re.sub(r"/\*\* 打包開啟分頁 \*/.*?// =========================================================================\n  // 分類與標籤/s", "// =========================================================================\n  // 分類與標籤", js, flags=re.DOTALL)

# 7. Add Dropbox Sync Logic
dropbox_code = '''
  // =========================================================================
  // Dropbox Sync Logic
  // =========================================================================
  
  const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
  const UPLOAD_URL = 'https://content.dropboxapi.com/2/files/upload';
  const DOWNLOAD_URL = 'https://content.dropboxapi.com/2/files/download';

  class SyncError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }

  async function getConfig() {
    const store = JSON.parse(localStorage.getItem('BookmarkSaverStore') || '{}');
    return {
      appKey: (store.dbxAppKey || '').trim(),
      appSecret: (store.dbxAppSecret || '').trim(),
      refreshToken: (store.dbxRefreshToken || '').trim(),
      filePath: normalizePath(store.dbxFilePath)
    };
  }

  async function getAccessToken(forceRefresh = false) {
    const cfg = await getConfig();
    if (!cfg.appKey || !cfg.appSecret || !cfg.refreshToken) {
      throw new SyncError('NO_CONFIG', '尚未設定 Dropbox 同步金鑰');
    }
    const cache = JSON.parse(sessionStorage.getItem('dbxTokenCache') || 'null');
    if (!forceRefresh && cache && cache.token && cache.expiresAt - 60000 > Date.now()) {
      return cache.token;
    }
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + btoa(cfg.appKey + ':' + cfg.appSecret)
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cfg.refreshToken })
    });
    const data = await response.json();
    if (!response.ok || !data.access_token) throw new SyncError('AUTH', Token 換發失敗);
    sessionStorage.setItem('dbxTokenCache', JSON.stringify({ token: data.access_token, expiresAt: Date.now() + (data.expires_in || 14400) * 1000 }));
    return data.access_token;
  }

  let uploadTimer = null;
  function requestUpload({ manual = false } = {}) {
    if (uploadTimer) clearTimeout(uploadTimer);
    if (manual) { syncUp(); return; }
    uploadTimer = setTimeout(() => syncUp(), 2000);
  }

  async function syncUp() {
    try {
      setStatus('syncing', '上傳中...', '正在將變更儲存到 Dropbox');
      const token = await getAccessToken();
      const cfg = await getConfig();
      const apiArg = JSON.stringify({ path: cfg.filePath, mode: 'overwrite', autorename: false, mute: true })
        .replace(/[\\u007F-\\uFFFF]/g, chr => '\\\\u' + ('0000' + chr.charCodeAt(0).toString(16)).slice(-4));
      const fileData = JSON.stringify({ links: state.links, updatedAt: Date.now() }, null, 2);
      const res = await fetch(UPLOAD_URL, {
        method: 'POST',
        headers: { 'Authorization': Bearer , 'Dropbox-API-Arg': apiArg, 'Content-Type': 'application/octet-stream' },
        body: fileData
      });
      if (!res.ok) throw new Error('上傳失敗');
      state.lastSyncAt = Date.now();
      const store = JSON.parse(localStorage.getItem('BookmarkSaverStore') || '{}');
      store.lastSyncAt = state.lastSyncAt;
      localStorage.setItem('BookmarkSaverStore', JSON.stringify(store));
      setStatus('synced', '已同步', 上次更新：剛才);
      render({ animate: false });
    } catch (e) {
      console.error(e);
      setStatus('error', '上傳失敗', e.message);
    }
  }

  async function syncDown({ mode = 'replace', manual = false } = {}) {
    try {
      setStatus('syncing', '下載中...', '正在從 Dropbox 取得資料');
      const token = await getAccessToken();
      const cfg = await getConfig();
      const apiArg = JSON.stringify({ path: cfg.filePath })
        .replace(/[\\u007F-\\uFFFF]/g, chr => '\\\\u' + ('0000' + chr.charCodeAt(0).toString(16)).slice(-4));
      const res = await fetch(DOWNLOAD_URL, {
        method: 'POST',
        headers: { 'Authorization': Bearer , 'Dropbox-API-Arg': apiArg }
      });
      
      let newLinks = [];
      if (res.status === 409) {
        newLinks = []; // Not found
      } else if (!res.ok) {
        throw new Error('下載失敗');
      } else {
        const json = await res.json();
        newLinks = normalizeLinks(json);
      }
      
      if (mode === 'merge') {
        const merged = [...state.links];
        newLinks.forEach(nl => { if (!merged.some(ml => ml.id === nl.id)) merged.push(nl); });
        state.links = merged.sort((a,b) => getTimestamp(b) - getTimestamp(a));
      } else {
        state.links = newLinks.sort((a,b) => getTimestamp(b) - getTimestamp(a));
      }
      
      state.lastSyncAt = Date.now();
      const store = JSON.parse(localStorage.getItem('BookmarkSaverStore') || '{}');
      store.savedLinks = state.links;
      store.lastSyncAt = state.lastSyncAt;
      localStorage.setItem('BookmarkSaverStore', JSON.stringify(store));
      setStatus('synced', '已同步', '剛才');
      render({ animate: true });
      if (mode === 'merge') syncUp();
    } catch (e) {
      console.error(e);
      setStatus('error', '下載失敗', e.message);
    }
  }

'''
js = js.replace("  // =========================================================================\n  // 背景通訊與同步", dropbox_code + "  // =========================================================================\n  // 背景通訊與同步")

# Replace saveSettings to use localStorage
save_settings_func = '''
  async function saveSettings() {
    const appKey = els.appKey.value.trim();
    const appSecret = els.appSecret.value.trim();
    const refreshToken = els.refreshToken.value.trim();
    let filePath = els.filePath.value.trim();
    if (!appKey || !appSecret || !refreshToken) return toast('請填寫完整金鑰資訊', 'error');
    filePath = normalizePath(filePath);
    els.filePath.value = filePath;
    const store = JSON.parse(localStorage.getItem('BookmarkSaverStore') || '{}');
    store.dbxAppKey = appKey;
    store.dbxAppSecret = appSecret;
    store.dbxRefreshToken = refreshToken;
    store.dbxFilePath = filePath;
    localStorage.setItem('BookmarkSaverStore', JSON.stringify(store));
    sessionStorage.removeItem('dbxTokenCache');
    state.configured = true;
    toast('設定已儲存，開始同步...', 'info');
    toggleSettings();
    if (state.links.length > 0) syncDown({ mode: 'merge', manual: true });
    else syncDown({ mode: 'replace', manual: true });
  }
'''
js = re.sub(r"async function saveSettings\(\) \{.*?\n  \}", save_settings_func.strip(), js, flags=re.DOTALL)

# Delete message listener
js = re.sub(r"chrome.runtime.onMessage.addListener.*?\}\);", "", js, flags=re.DOTALL)
js = re.sub(r"  function updateAddButton\(\) \{.*?\}\n", "", js, flags=re.DOTALL)
js = js.replace("updateAddButton();", "")

with open('app.js', 'w', encoding='utf-8') as f:
    f.write(js)
