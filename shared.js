/* Authentication uses an explicit bearer token, independent of cross-site cookies. */
(function (root) {
  'use strict';
  const SESSION = 'somhouse-session-v1', SERVER = 'somhouse-server-url';
  function serverURL(value) {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
      throw Error('맥미니의 HTTPS 주소를 입력해 주세요. 로컬 시험은 http://127.0.0.1:8787을 사용할 수 있어요.');
    }
    return url.origin;
  }
  class Client {
    constructor() {
      this.base = ''; this.token = ''; this.username = '';
      try {this.base = serverURL(root.SOMHOUSE_API_URL);} catch {}
      if (['localhost', '127.0.0.1'].includes(location.hostname)) this.base = 'http://127.0.0.1:8787';
      try { this.base = serverURL(localStorage.getItem(SERVER)); } catch {}
      try {
        const saved = JSON.parse(sessionStorage.getItem(SESSION));
        if (saved && typeof saved.token === 'string' && typeof saved.username === 'string') {
          this.base = serverURL(saved.base); this.token = saved.token; this.username = saved.username;
        }
      } catch {}
      if (!this.base && ['localhost', '127.0.0.1'].includes(location.hostname)) this.base = 'http://127.0.0.1:8787';
    }
    async request(path, method = 'GET', body, base = this.base, token = this.token) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const headers = {};
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (token) headers.Authorization = 'Bearer ' + token;
        const response = await fetch(base + path, {method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials:'omit', cache:'no-store', signal:controller.signal});
        const result = await response.json();
        if (!response.ok) {const error = Error(result.error || '요청을 완료하지 못했어요.');error.status=response.status;throw error;}
        return result;
      } catch (error) {
        if (error.status) throw error;
        throw Error('맥미니에 연결하지 못했어요. 연결을 확인하고 다시 시도해 주세요. 입력한 내용은 유지됩니다.');
      } finally {clearTimeout(timeout);}
    }
    async login(base, username, password) {
      base = serverURL(base);
      const result = await this.request('/api/login', 'POST', {username, password}, base, '');
      this.base = base; this.token = result.token; this.username = result.username;
      try {localStorage.setItem(SERVER, base);} catch {}
      try {sessionStorage.setItem(SESSION, JSON.stringify({base, ...result}));} catch {}
    }
    clear() {
      this.token = ''; this.username = '';
      try {sessionStorage.removeItem(SESSION);} catch {}
    }
    async logout() {try {await this.request('/api/logout', 'POST', {});} finally {this.clear();}}
    async load() {return (await this.request('/api/data')).data;}
    async put(kind, item) {return (await this.request('/api/items/' + kind + '/' + encodeURIComponent(item.id), 'PUT', item)).data;}
    async remove(kind, id) {return (await this.request('/api/items/' + kind + '/' + encodeURIComponent(id), 'DELETE')).data;}
    async merge(data, restore=false) {return this.request(restore?'/api/restore':'/api/merge', 'POST', data);}
  }
  const api = {Client, serverURL};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SomhouseShared = api;
})(typeof window !== 'undefined' ? window : this);
