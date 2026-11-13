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
      for (const name of ['localStorage', 'sessionStorage']) {
        try {
          const saved = JSON.parse(root[name].getItem(SESSION));
          if (!saved || typeof saved.token !== 'string' || !saved.token || typeof saved.username !== 'string') continue;
          this.base = serverURL(saved.base); this.token = saved.token; this.username = saved.username;
          if (name === 'sessionStorage') this.remember();
          break;
        } catch {}
      }
      if (!this.base && ['localhost', '127.0.0.1'].includes(location.hostname)) this.base = 'http://127.0.0.1:8787';
    }
    async request(path, method = 'GET', body, base = this.base, token = this.token, timeoutMs = 15000) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
        if (controller.signal.aborted) throw Error('응답이 늦어지고 있어요. 잠시 후 다시 시도해 주세요. 입력한 내용은 유지됩니다.');
        throw Error('맥미니에 연결하지 못했어요. 연결을 확인하고 다시 시도해 주세요. 입력한 내용은 유지됩니다.');
      } finally {clearTimeout(timeout);}
    }
    async login(base, username, password) {
      base = serverURL(base);
      const result = await this.request('/api/login', 'POST', {username, password}, base, '');
      this.base = base; this.token = result.token; this.username = result.username;
      try {localStorage.setItem(SERVER, base);} catch {}
      this.remember();
    }
    remember() {
      const saved = JSON.stringify({base: this.base, token: this.token, username: this.username});
      try {
        localStorage.setItem(SESSION, saved);
      } catch {
        try {sessionStorage.setItem(SESSION, saved);} catch {}
        return;
      }
      try {sessionStorage.removeItem(SESSION);} catch {}
    }
    clear() {
      const token = this.token;
      this.token = ''; this.username = '';
      for (const name of ['localStorage', 'sessionStorage']) {
        try {
          const storage = root[name];
          if (JSON.parse(storage.getItem(SESSION))?.token === token) storage.removeItem(SESSION);
        } catch {}
      }
    }
    sessionEnded(event) {
      if (!this.token) return false;
      try {
        if (event.key === null) return event.storageArea === localStorage;
        return event.key === SESSION && event.newValue === null && JSON.parse(event.oldValue)?.token === this.token;
      } catch {return false;}
    }
    async logout() {
      try {await this.request('/api/logout', 'POST', {});}
      catch (error) {if (error.status !== 401) throw error;}
      this.clear();
    }
    async changePassword(currentPassword, newPassword) {
      await this.request('/api/password', 'POST', {currentPassword, newPassword});
    }
    async aiStatus() {return this.request('/api/ai');}
    async askAI(question, scope) {
      return this.request('/api/ai', 'POST', {question, scope}, this.base, this.token, 50000);
    }
    async load() {return (await this.request('/api/data')).data;}
    async put(kind, item) {return (await this.request('/api/items/' + kind + '/' + encodeURIComponent(item.id), 'PUT', item)).data;}
    async remove(kind, id) {return (await this.request('/api/items/' + kind + '/' + encodeURIComponent(id), 'DELETE')).data;}
    async merge(data) {return this.request('/api/merge', 'POST', data);}
  }
  const api = {Client, serverURL};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SomhouseShared = api;
})(typeof window !== 'undefined' ? window : this);
