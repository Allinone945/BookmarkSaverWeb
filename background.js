/**
 * BookmarkSaver - 背景 Service Worker
 * 負責所有 Dropbox API 通訊：
 *  1. 用 Refresh Token 換發短期 Access Token (並快取到過期前)
 *  2. 下載 / 上傳 JSON 檔
 * 放在背景執行的好處：就算 popup 已經關閉，上傳仍會完成，不會遺失變更。
 */
importScripts('shared.js');

const { normalizeLinks, normalizePath } = self.BookmarkShared;

const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const UPLOAD_URL = 'https://content.dropboxapi.com/2/files/upload';
const DOWNLOAD_URL = 'https://content.dropboxapi.com/2/files/download';
const CONFIG_KEYS = ['dbxAppKey', 'dbxAppSecret', 'dbxRefreshToken', 'dbxFilePath'];
const TOKEN_CACHE_KEY = 'dbxTokenCache';

class SyncError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 設定與 Token
// ---------------------------------------------------------------------------

async function getConfig() {
  const cfg = await chrome.storage.local.get(CONFIG_KEYS);
  return {
    appKey: (cfg.dbxAppKey || '').trim(),
    appSecret: (cfg.dbxAppSecret || '').trim(),
    refreshToken: (cfg.dbxRefreshToken || '').trim(),
    filePath: normalizePath(cfg.dbxFilePath)
  };
}

const sessionStore = chrome.storage.session || null;

async function readTokenCache() {
  if (!sessionStore) return null;
  const data = await sessionStore.get(TOKEN_CACHE_KEY);
  return data[TOKEN_CACHE_KEY] || null;
}

async function writeTokenCache(value) {
  if (!sessionStore) return;
  if (value) await sessionStore.set({ [TOKEN_CACHE_KEY]: value });
  else await sessionStore.remove(TOKEN_CACHE_KEY);
}

// 金鑰被修改時，丟棄舊的 Access Token
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && CONFIG_KEYS.some((k) => k in changes)) {
    writeTokenCache(null);
  }
});

async function getAccessToken(forceRefresh = false) {
  const cfg = await getConfig();
  if (!cfg.appKey || !cfg.appSecret || !cfg.refreshToken) {
    throw new SyncError('NO_CONFIG', '尚未設定 Dropbox 同步金鑰');
  }

  if (!forceRefresh) {
    const cache = await readTokenCache();
    if (cache && cache.token && cache.expiresAt - 60 * 1000 > Date.now()) {
      return cache.token;
    }
  }

  let response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + btoa(cfg.appKey + ':' + cfg.appSecret)
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: cfg.refreshToken
      })
    });
  } catch (err) {
    throw new SyncError('NETWORK', '無法連線到 Dropbox，請檢查網路');
  }

  let data = {};
  try { data = await response.json(); } catch (_) { /* ignore */ }

  if (!response.ok || !data.access_token) {
    const reason = data.error_description || data.error || `HTTP ${response.status}`;
    throw new SyncError('AUTH', `Token 換發失敗：${reason}`);
  }

  await writeTokenCache({
    token: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 14400) * 1000
  });
  return data.access_token;
}

/** 自動附上 Token；若遇到 401 (Token 失效) 會強制換發後重試一次 */
async function dropboxFetch(buildRequest) {
  let token = await getAccessToken();
  let response;
  try {
    response = await buildRequest(token);
    if (response.status === 401) {
      token = await getAccessToken(true);
      response = await buildRequest(token);
    }
  } catch (err) {
    if (err instanceof SyncError) throw err;
    throw new SyncError('NETWORK', '無法連線到 Dropbox，請檢查網路');
  }
  return response;
}

/** Dropbox-API-Arg 標頭只允許 ASCII，中文路徑需轉成 \uXXXX */
function toHeaderSafeJson(obj) {
  return JSON.stringify(obj).replace(/[\u007f-\uffff]/g,
    (c) => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
}

async function markSynced() {
  const syncedAt = Date.now();
  await chrome.storage.local.set({ lastSyncAt: syncedAt });
  return syncedAt;
}

// ---------------------------------------------------------------------------
// 下載
// ---------------------------------------------------------------------------

async function downloadLinks() {
  const { filePath } = await getConfig();
  const response = await dropboxFetch((token) => fetch(DOWNLOAD_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Dropbox-API-Arg': toHeaderSafeJson({ path: filePath })
    }
  }));

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 409 && text.includes('not_found')) {
      return { notFound: true, filePath };
    }
    throw new SyncError('HTTP', `下載失敗 (HTTP ${response.status})：${text.slice(0, 300)}`);
  }

  const text = (await response.text()).replace(/^\uFEFF/, '');
  let data;
  try {
    data = text.trim() ? JSON.parse(text) : [];
  } catch (_) {
    throw new SyncError('PARSE', `雲端檔案 ${filePath} 不是有效的 JSON`);
  }

  const syncedAt = await markSynced();
  return { links: normalizeLinks(data), filePath, syncedAt };
}

// ---------------------------------------------------------------------------
// 上傳 (序列化 + 合併：連續多次變更只會上傳最後的狀態)
// ---------------------------------------------------------------------------

async function uploadLinksNow() {
  const { filePath } = await getConfig();
  const { savedLinks } = await chrome.storage.local.get('savedLinks');
  const links = Array.isArray(savedLinks) ? savedLinks : [];
  const body = new Blob([JSON.stringify(links, null, 2)], { type: 'application/octet-stream' });

  const response = await dropboxFetch((token) => fetch(UPLOAD_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': toHeaderSafeJson({
        path: filePath,
        mode: { '.tag': 'overwrite' },
        autorename: false,
        mute: true
      })
    },
    body
  }));

  if (!response.ok) {
    const text = await response.text();
    throw new SyncError('HTTP', `上傳失敗 (HTTP ${response.status})：${text.slice(0, 300)}`);
  }

  const syncedAt = await markSynced();
  return { count: links.length, filePath, syncedAt };
}

let uploadChain = Promise.resolve();
let pendingUploads = 0;

function queueUpload() {
  pendingUploads++;
  const job = uploadChain.then(() => {
    pendingUploads--;
    // 後面還有排隊的上傳 → 這次略過，由最後一次上傳最新狀態即可
    if (pendingUploads > 0) return { skipped: true };
    return uploadLinksNow();
  });
  uploadChain = job.catch(() => {});
  return job;
}

// ---------------------------------------------------------------------------
// 與 popup 溝通
// ---------------------------------------------------------------------------

const HANDLERS = {
  upload: queueUpload,
  download: downloadLinks
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = message && HANDLERS[message.type];
  if (!handler) return false;

  handler()
    .then((result) => sendResponse(Object.assign({ ok: true }, result)))
    .catch((err) => sendResponse({
      ok: false,
      code: err.code || 'ERROR',
      error: err.message || String(err)
    }));
  return true; // 非同步回應
});
