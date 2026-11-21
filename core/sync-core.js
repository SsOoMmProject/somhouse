/* The heart of the future app (docs/APP_ARCHITECTURE_PLAN.md, PR #31): every phone keeps its own copy, and the family's
   Google Sheet holds an append-only log of changes. Nothing in the running web app loads this file yet.

   Any phones that have read the same changes, in any order and with repeats, show exactly the same records.
   The rule stays the one the family already has: the last save of an item wins. "Last" uses a hybrid clock, so a phone
   whose clock runs slow still wins when it edits something it has already seen. */
(function (root) {
  'use strict';
  const KINDS = ['records', 'schedule', 'shopping'];
  const COLUMNS = ['event', 'stamp', 'device', 'kind', 'item', 'op', 'body'];
  const MAX_CELL = 45000; // A Google Sheets cell holds 50,000 characters.
  const FUTURE_LIMIT_MS = 24 * 3600000;
  const pad = (value, size) => String(value).padStart(size, '0');
  // "wall time - counter - device" sorts correctly as plain text.
  const formatStamp = ({wall, counter, device}) => `${pad(wall, 15)}-${pad(counter, 6)}-${device}`;
  function parseStamp(stamp) {
    const m = /^(\d{15})-(\d{6})-([A-Za-z0-9_-]{1,40})$/.exec(String(stamp));
    return m ? {wall: Number(m[1]), counter: Number(m[2]), device: m[3]} : null;
  }
  class Clock {
    constructor(device, last = null) {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(device)) throw Error('기기 ID를 확인해 주세요.');
      this.device = device;
      const known = last && parseStamp(last);
      this.wall = known ? known.wall : 0;
      this.counter = known ? known.counter : 0;
    }
    tick(now = Date.now()) {
      if (now > this.wall) { this.wall = now; this.counter = 0; } else this.counter++;
      return formatStamp(this);
    }
    // Move past a stamp seen from another phone. A stamp far in the future is a broken clock and is not followed.
    observe(stamp, now = Date.now()) {
      const seen = parseStamp(stamp);
      if (!seen || seen.wall > now + FUTURE_LIMIT_MS) return;
      if (seen.wall > this.wall) { this.wall = seen.wall; this.counter = seen.counter; }
      else if (seen.wall === this.wall && seen.counter > this.counter) this.counter = seen.counter;
    }
  }
  function validEvent(e) {
    return Boolean(e) && typeof e.event === 'string' && e.event.length > 0 && e.event.length <= 100 && parseStamp(e.stamp) !== null
      && parseStamp(e.stamp).device === e.device && KINDS.includes(e.kind) && typeof e.item === 'string' && e.item.length > 0 && e.item.length <= 200
      && (e.op === 'delete' ? e.body === null || e.body === undefined : e.op === 'put' && e.body !== null && typeof e.body === 'object' && !Array.isArray(e.body) && e.body.id === e.item);
  }
  function createEvent(clock, kind, op, item, now = Date.now()) {
    const id = op === 'delete' ? item : item?.id, stamp = clock.tick(now);
    const event = {event: stamp, stamp, device: clock.device, kind, item: id, op, body: op === 'delete' ? null : item};
    if (!validEvent(event)) throw Error('기록 변경을 확인해 주세요.');
    return event;
  }
  // Repeats of the same event are one event; order does not matter.
  function mergeLogs(...logs) {
    const byId = new Map();
    for (const log of logs) for (const e of log) if (validEvent(e) && !byId.has(e.event)) byId.set(e.event, e);
    return [...byId.values()].sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0));
  }
  // The last change of each item decides. A deleted item stays deleted until a later save.
  function reduce(log) {
    const winners = new Map();
    for (const e of mergeLogs(log)) winners.set(`${e.kind}\u0000${e.item}`, e);
    const state = {records: [], schedule: [], shopping: []};
    for (const e of [...winners.values()].sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0))) if (e.op === 'put') state[e.kind].push(e.body);
    return state;
  }
  // A shorter log with the same result, for a sheet that has grown. Deletions stay for `keepDeletesMs`, so a phone that was
  // away can still hear about them. A phone away for longer must load from scratch.
  function compact(log, now = Date.now(), keepDeletesMs = 90 * 86400000) {
    const winners = new Map();
    for (const e of mergeLogs(log)) winners.set(`${e.kind}\u0000${e.item}`, e);
    return [...winners.values()].filter(e => e.op === 'put' || now - parseStamp(e.stamp).wall <= keepDeletesMs)
      .sort((a, b) => (a.stamp < b.stamp ? -1 : 1));
  }
  // Sheet cells stay text: a leading apostrophe stops Sheets from reading a value as a formula, date or number.
  const toCell = text => `'${text}`;
  const fromCell = value => (String(value ?? '').startsWith("'") ? String(value).slice(1) : String(value ?? ''));
  function toRow(e) {
    const body = e.op === 'put' ? JSON.stringify(e.body) : '';
    if (body.length > MAX_CELL) throw Error('한 기록이 너무 길어 시트에 저장할 수 없어요.');
    return [e.event, e.stamp, e.device, e.kind, e.item, e.op, body].map(toCell);
  }
  function fromRow(row) {
    if (!Array.isArray(row) || row.length < COLUMNS.length) return null;
    const [event, stamp, device, kind, item, op, body] = row.map(fromCell);
    let parsed = null;
    if (op === 'put') { try { parsed = JSON.parse(body); } catch { return null; } }
    const e = {event, stamp, device, kind, item, op, body: parsed};
    return validEvent(e) ? e : null;
  }

  // Keeps a phone's copy and its unsent changes in step with a shared log. `backend` is read(fromRow) / append(rows);
  // `storage` is get/set of one JSON value. Safe to stop at any point: it only forgets a change once it has seen it in the log.
  class SyncEngine {
    constructor({device, backend, storage, now = () => Date.now()}) {
      this.backend = backend; this.storage = storage; this.now = now;
      const saved = storage.get() || {};
      this.log = Array.isArray(saved.log) ? mergeLogs(saved.log) : [];
      this.outbox = Array.isArray(saved.outbox) ? saved.outbox.filter(validEvent) : [];
      this.nextRow = Number.isInteger(saved.nextRow) && saved.nextRow >= 0 ? saved.nextRow : 0;
      this.skipped = Number.isInteger(saved.skipped) ? saved.skipped : 0;
      this.clock = new Clock(device, saved.clock || null);
      for (const e of [...this.log, ...this.outbox]) this.clock.observe(e.stamp, this.now());
    }
    persist() {
      this.storage.set({log: this.log, outbox: this.outbox, nextRow: this.nextRow, skipped: this.skipped, clock: formatStamp(this.clock)});
    }
    state() { return reduce([...this.log, ...this.outbox]); }
    change(kind, op, item) {
      const event = createEvent(this.clock, kind, op, item, this.now());
      this.outbox.push(event);
      this.persist();
      return event;
    }
    async pull() {
      const rows = await this.backend.read(this.nextRow), fresh = [];
      for (const row of rows) {
        const e = fromRow(row);
        if (e) { fresh.push(e); this.clock.observe(e.stamp, this.now()); } else this.skipped++;
      }
      this.nextRow += rows.length;
      this.log = mergeLogs(this.log, fresh);
      const inLog = new Set(this.log.map(e => e.event));
      this.outbox = this.outbox.filter(e => !inLog.has(e.event));
      this.persist();
      return fresh.length;
    }
    // Reads first, so a change that reached the sheet before a lost reply is not written twice.
    async sync() {
      await this.pull();
      if (this.outbox.length) {
        await this.backend.append(this.outbox.map(toRow));
        await this.pull();
      }
      return {state: this.state(), waiting: this.outbox.length, skipped: this.skipped};
    }
  }
  class MemoryBackend {
    constructor() { this.rows = []; }
    async read(from) { return this.rows.slice(from).map(row => [...row]); }
    async append(rows) { this.rows.push(...rows.map(row => [...row])); }
  }
  // The family's own spreadsheet through the Google Sheets REST API, with a token from the phone's Google sign-in.
  class SheetsBackend {
    constructor({sheetId, tab = '이벤트', token, fetcher = (...args) => fetch(...args)}) {
      if (!/^[A-Za-z0-9_-]{10,100}$/.test(sheetId || '')) throw Error('시트 ID를 확인해 주세요.');
      this.sheetId = sheetId; this.tab = tab; this.token = token; this.fetcher = fetcher;
    }
    range(a1) { return encodeURIComponent(`'${this.tab.replace(/'/g, "''")}'!${a1}`); }
    async call(path, options = {}) {
      const token = await this.token();
      const response = await this.fetcher(`https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}${path}`, {...options, cache: 'no-store', credentials: 'omit', headers: {Authorization: `Bearer ${token}`, ...(options.body ? {'Content-Type': 'application/json'} : {})}});
      if (!response.ok) { const error = Error(`Google 시트 요청 실패 (${response.status})`); error.status = response.status; error.retry = response.status === 429 || response.status >= 500; throw error; }
      return response.json();
    }
    async read(from) {
      const body = await this.call(`/values/${this.range(`A${from + 2}:G`)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`);
      return Array.isArray(body.values) ? body.values : [];
    }
    async append(rows) {
      await this.call(`/values/${this.range('A:G')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {method: 'POST', body: JSON.stringify({majorDimension: 'ROWS', values: rows.map(row => row.map(fromCell))})});
    }
  }
  const api = {KINDS, COLUMNS, Clock, createEvent, validEvent, mergeLogs, reduce, compact, toRow, fromRow, SyncEngine, MemoryBackend, SheetsBackend, formatStamp, parseStamp};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SomhouseSync = api;
})(typeof window !== 'undefined' ? window : this);
