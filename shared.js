/**
 * BookmarkSaver - 共用工具 (popup.js 與 background.js 共用)
 * 資料格式與 v2.4 完全相容：
 * { id, createdAt, title, url, isStarred, isArchived, isHearted }
 */
(function (root) {
  'use strict';

  const DEFAULT_FILE_PATH = '/MyLinks.json';

  /** 產生與 v2.4 相同格式的 ID：Date.now() + 5 碼亂數 */
  function generateId() {
    return Date.now().toString() + Math.random().toString(36).slice(2, 7);
  }

  /** 取得建立時間：優先 createdAt，舊資料則由 id 前綴的 Date.now() 推算 */
  function getTimestamp(link) {
    const created = Number(link && link.createdAt);
    if (Number.isFinite(created) && created > 0) return created;
    const fromId = parseInt(link && link.id, 10);
    return Number.isFinite(fromId) && fromId > 0 ? fromId : 0;
  }

  /** 修正單筆資料，保留未知欄位以免覆蓋到其他工具寫入的資訊 */
  function normalizeLink(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.url !== 'string' || !raw.url.trim()) return null;

    const link = Object.assign({}, raw);
    link.url = raw.url.trim();
    link.id = raw.id !== undefined && raw.id !== null && String(raw.id) ? String(raw.id) : generateId();
    link.createdAt = getTimestamp(raw) || Date.now();
    link.title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : link.url;
    link.isStarred = !!raw.isStarred;
    link.isArchived = !!raw.isArchived;
    link.isHearted = !!raw.isHearted;
    return link;
  }

  /** 接受陣列 (v2.4 格式) 或 { links: [] }，回傳乾淨的連結陣列 */
  function normalizeLinks(data) {
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.links) ? data.links : []);
    return list.map(normalizeLink).filter(Boolean);
  }

  /** Dropbox 路徑必須以 / 開頭 */
  function normalizePath(path) {
    let p = (path || '').trim();
    if (!p) return DEFAULT_FILE_PATH;
    if (!p.startsWith('/')) p = '/' + p;
    return p;
  }

  root.BookmarkShared = {
    DEFAULT_FILE_PATH,
    generateId,
    getTimestamp,
    normalizeLink,
    normalizeLinks,
    normalizePath
  };
})(typeof self !== 'undefined' ? self : this);
