'use strict';
/* Recording never waits for the network. A save that cannot reach the server stays on this device and goes out by
   itself when the connection is back, in the order it was made (saves are repeatable, so a lost reply is harmless).
   The screen also opens from the last copy of the family's records with no connection at all.
   Both are per signed-in account; the copy is removed at logout. Unsent saves stay until they are delivered. */
(function () {
  const H = SomhouseFeatures, QUEUE = 'somhouse-offline-queue-v1', COPY = 'somhouse-offline-copy-v1', COPY_AT = 'somhouse-offline-copy-at-v1';
  const FAST_MS = 8000, COPY_EVERY_MS = 15000, OPEN_SLEEP_MINUTES = 16 * 60;
  const on = () => Boolean(shared?.token) && !shared.readOnly && H.allowed('offline', shared.family);
  const read = key => { try { const value = JSON.parse(localStorage.getItem(key) || '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; } };
  const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };
  function mine(key, change) {
    const all = read(key), account = aiAccount();
    if (change === undefined) return all[account];
    if (change === null) delete all[account]; else all[account] = change;
    if (Object.keys(all).length) return write(key, all);
    try { localStorage.removeItem(key); } catch {}
    return true;
  }
  const pending = () => { const list = mine(QUEUE); return Array.isArray(list) ? list : []; };
  const setPending = list => mine(QUEUE, list.length ? list : null);
  const waiting = () => pending().filter(x => !x.rejected);

  // Same rule as sleep_wake.py: a feeding ends the latest open sleep that began at or before it, within 16 hours.
  function endSleep(list, at) {
    let found = -1;
    list.forEach((x, i) => {
      if (x.type !== 'sleep' || x.end || !x.date || x.date > at) return;
      if ((Somhouse.sleepMinutes({date: x.date, end: at}) ?? 0) > OPEN_SLEEP_MINUTES) return;
      if (found < 0 || x.date > list[found].date) found = i;
    });
    if (found < 0) return;
    const sleep = list[found], end = at > sleep.date ? at : Somhouse.localDateTime(new Date(new Date(sleep.date + ':00').getTime() + 60000));
    list[found] = {...sleep, end};
  }
  // The server's records with this device's unsent changes on top.
  function overlay(base) {
    const next = {records: [...base.records], schedule: [...base.schedule], shopping: [...base.shopping]};
    for (const op of waiting()) {
      const list = next[op.kind];
      if (!list) continue;
      const at = list.findIndex(x => x.id === op.id);
      if (op.op === 'delete') { if (at >= 0) list.splice(at, 1); continue; }
      if (at >= 0) list[at] = op.item; else list.push(op.item);
      if (op.kind === 'records' && op.item.type === 'feeding') endSleep(list, op.item.date);
    }
    return next;
  }
  async function send(op, timeoutMs) {
    const path = `/api/items/${op.kind}/${encodeURIComponent(op.id)}`;
    const result = await shared.attempt(path, op.op === 'delete' ? 'DELETE' : 'PUT', op.op === 'delete' ? undefined : op.item, shared.base, shared.token, timeoutMs);
    if (result.aliases) shared.aliases = result.aliases;
    return result.data;
  }
  // No answer, or a server that is struggling: try again later. Any other refusal will not change by retrying.
  const temporary = error => !error.status || error.status >= 500;
  let flushing = null;
  function flush() {
    if (flushing) return flushing;
    if (!waiting().length) return Promise.resolve();
    flushing = (async () => {
      for (let next = waiting()[0]; next; next = waiting()[0]) {
        try {
          await send(next, 30000);
          setPending(pending().filter(x => x.key !== next.key));
        } catch (error) {
          if (temporary(error)) return;
          if (error.status === 401) throw error;
          setPending(pending().map(x => x.key === next.key ? {...x, rejected: String(error.message || '').slice(0, 200) || '저장하지 못했어요.'} : x));
        }
      }
    })().finally(() => { flushing = null; });
    return flushing;
  }
  // A later change to the same item replaces the earlier one, keeping its place in line.
  function enqueue(op) {
    const list = pending(), key = `${op.kind}/${op.id}`, at = list.findIndex(x => x.key === key && !x.rejected);
    const entry = {...op, key, at: new Date().toISOString()};
    if (at >= 0) list[at] = entry; else list.push(entry);
    return setPending(list);
  }
  async function change(op, direct) {
    if (!on()) return direct();
    if (waiting().length) await flush();
    if (!waiting().length && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
      try { return overlay(await send(op, FAST_MS)); }
      catch (error) { if (!temporary(error)) throw error; }
    }
    if (!enqueue(op)) throw Error('이 기기에 임시로 저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요. 입력한 내용은 유지됩니다.');
    setTimeout(() => message(`📴 연결이 안 돼서 이 기기에 저장했어요. 연결되면 자동으로 보내요. (대기 ${waiting().length}건)`), 0);
    return overlay(data);
  }

  let copied = '', copiedAt = 0;
  function keepCopy(fresh) {
    const now = Date.now();
    if (now - copiedAt < COPY_EVERY_MS) return;
    copiedAt = now;
    mine(COPY_AT, now);
    const body = JSON.stringify([fresh, shared.settings]);
    if (body === copied) return;
    if (mine(COPY, {data: fresh, settings: shared.settings})) copied = body;
  }
  // The first load failed: open from the last copy, showing how old it is. The error still reaches the app's status line.
  function openCopy() {
    if (sharedReady) return;
    const copy = mine(COPY);
    if (!copy || !valid(copy.data)) return;
    data = overlay(copy.data);
    if (copy.settings && Array.isArray(copy.settings.children)) shared.settings = copy.settings;
    const at = Number(mine(COPY_AT));
    lastSync = Number.isFinite(at) ? at : 0;
    sharedReady = true;
    render();
  }
  let registered = false;
  function registerWorker() {
    if (registered || typeof navigator === 'undefined' || !navigator.serviceWorker) return;
    registered = true;
    navigator.serviceWorker.register('sw.js').catch(() => { registered = false; });
  }
  function banner() {
    if (!on()) return '';
    const list = pending(), count = waiting().length, refused = list.filter(x => x.rejected);
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (!count && !refused.length && !offline) return '';
    const label = x => x.op === 'delete' ? '삭제' : esc(x.item?.title || x.item?.amount || x.item?.category || x.item?.hospital || '기록');
    const when = lastSync ? ` · 화면은 ${esc(Somhouse.localDateTime(new Date(lastSync)).slice(5).replace('-', '/').replace('T', ' '))} 기준` : '';
    const head = offline || count
      ? `<p><strong>📴 ${offline ? '지금 오프라인이에요' : '서버에 연결되지 않았어요'}</strong>${when}${count ? `<br>이 기기에 저장한 기록 ${count}건은 연결되면 자동으로 보내요.` : '<br>기록하면 이 기기에 저장했다가 연결되면 보내요.'}</p>` : '';
    const rows = refused.map(x => `<div class="check-row"><p><strong>서버가 받지 않은 기록: ${label(x)}</strong><br><span class="caption">${esc(x.rejected)}</span></p><div class="actions"><button type="button" class="plain small" data-offline-drop="${esc(x.key)}">이 기록 버리기</button></div></div>`).join('');
    return `<section class="card checks-card offline-banner" role="status" aria-label="오프라인 상태">${head}${rows}</section>`;
  }

  H.register({
    id: 'offline',
    init() {
      if (!shared) return;
      const direct = {put: shared.put.bind(shared), remove: shared.remove.bind(shared), load: shared.load.bind(shared), clear: shared.clear.bind(shared)};
      shared.put = (kind, item) => change({op: 'put', kind, id: item.id, item}, () => direct.put(kind, item));
      shared.remove = (kind, id) => change({op: 'delete', kind, id}, () => direct.remove(kind, id));
      shared.load = async () => {
        if (!on()) return direct.load();
        await flush();
        try {
          const fresh = await direct.load();
          keepCopy(fresh);
          registerWorker();
          return overlay(fresh);
        } catch (error) {
          if (!error.status) openCopy();
          throw error;
        }
      };
      shared.clear = () => {
        if (shared.token) mine(COPY, null), mine(COPY_AT, null);
        copied = ''; copiedAt = 0;
        direct.clear();
      };
      if (typeof window.addEventListener === 'function') window.addEventListener('offline', () => { if (sharedReady && !editingScreen()) render(); });
      // A load that began before this file arrived did not go through the wrappers above.
      if (shared.token && mode === 'shared') Promise.resolve(refreshTask).catch(() => {}).then(() => refreshShared(true));
    },
    slots: {alert: banner, records: banner},
    click(button) {
      const key = button.dataset?.offlineDrop;
      if (!key) return false;
      if (confirm('이 기록을 버릴까요? 다른 휴대폰에도 전달되지 않아요.')) { setPending(pending().filter(x => x.key !== key || !x.rejected)); render(); }
      return true;
    },
  });
})();
