'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const S = require('../core/sync-core.js');

const feed = (id, amount = '120ml') => ({id, type: 'feeding', date: '2026-11-20T09:00', category: '분유', amount});
const memoryStore = (start = null) => { let value = start; return {get: () => (value === null ? null : JSON.parse(JSON.stringify(value))), set: x => { value = JSON.parse(JSON.stringify(x)); }}; };
function random(seed) { let x = seed; return n => { x = (x * 16807) % 2147483647; return x % n; }; }
const shuffle = (list, r) => { const out = [...list]; for (let i = out.length - 1; i > 0; i--) { const j = r(i + 1); [out[i], out[j]] = [out[j], out[i]]; } return out; };

test('the clock always moves forward, even when the phone clock jumps back', () => {
 const c = new S.Clock('phone-a'), a = c.tick(1000), b = c.tick(1000), d = c.tick(500), e = c.tick(2000);
 assert.ok(a < b && b < d && d < e);
});

test('an edit made after seeing a change wins even on a phone with a slow clock', () => {
 const fast = new S.Clock('fast'), slow = new S.Clock('slow');
 const first = S.createEvent(fast, 'records', 'put', feed('a', '100ml'), 100000);
 slow.observe(first.stamp, 50000);
 const second = S.createEvent(slow, 'records', 'put', feed('a', '150ml'), 50000);
 assert.equal(S.reduce([first, second]).records[0].amount, '150ml');
 assert.equal(S.reduce([second, first]).records[0].amount, '150ml');
});

test('a phone with a clock far in the future cannot drag the others along', () => {
 const c = new S.Clock('ok'), broken = new S.Clock('broken');
 const bad = S.createEvent(broken, 'records', 'put', feed('a'), 10 ** 13);
 c.observe(bad.stamp, 1000);
 assert.ok(c.tick(1000) < bad.stamp);
});

test('order and repeats do not change the result', () => {
 const a = new S.Clock('a'), b = new S.Clock('b'), log = [];
 for (let i = 0; i < 40; i++) {
  const clock = i % 2 ? a : b, id = 'item' + (i % 7);
  log.push(i % 5 === 4 ? S.createEvent(clock, 'records', 'delete', id, 1000 + i) : S.createEvent(clock, 'records', 'put', feed(id, `${i}ml`), 1000 + i));
 }
 const want = S.reduce(log), r = random(5);
 for (let round = 0; round < 50; round++) assert.deepEqual(S.reduce(shuffle([...log, ...log.slice(0, r(40))], r)), want);
});

test('a later save brings a deleted item back; an earlier one does not', () => {
 const c = new S.Clock('a'), put = S.createEvent(c, 'records', 'put', feed('x'), 1), del = S.createEvent(c, 'records', 'delete', 'x', 2), again = S.createEvent(c, 'records', 'put', feed('x', '90ml'), 3);
 assert.deepEqual(S.reduce([put, del]).records, []);
 assert.equal(S.reduce([del, again, put]).records[0].amount, '90ml');
});

test('compaction keeps the same result and forgets only old deletions', () => {
 const c = new S.Clock('a'), day = 86400000, log = [S.createEvent(c, 'records', 'put', feed('x', '1ml'), day), S.createEvent(c, 'records', 'put', feed('x', '2ml'), 2 * day), S.createEvent(c, 'records', 'put', feed('gone'), 3 * day), S.createEvent(c, 'records', 'delete', 'gone', 4 * day), S.createEvent(c, 'schedule', 'put', {id: 's', date: '2026-11-20T09:00', title: '접종'}, 5 * day)];
 const short = S.compact(log, 10 * day);
 assert.equal(short.length, 3);
 assert.deepEqual(S.reduce(short), S.reduce(log));
 assert.equal(S.compact(log, 200 * day).length, 2, 'an old deletion goes');
});

test('rows round-trip, and text that looks like a formula stays text', () => {
 const c = new S.Clock('a'), e = S.createEvent(c, 'records', 'put', {...feed('=SUM(A1)'), memo: '=IMPORTXML("x")\n"따옴표"'}, 1000);
 const row = S.toRow(e);
 assert.ok(row.every(cell => cell.startsWith("'")));
 assert.deepEqual(S.fromRow(row), e);
 assert.deepEqual(S.fromRow(row.map(x => x.slice(1))), e, 'Google may return the value without the apostrophe');
 const del = S.createEvent(c, 'records', 'delete', 'x', 2000);
 assert.deepEqual(S.fromRow(S.toRow(del)), del);
});

test('broken rows are skipped, never trusted', () => {
 const c = new S.Clock('a'), good = S.toRow(S.createEvent(c, 'records', 'put', feed('x'), 1000));
 for (const bad of [null, [], ['a'], [...good.slice(0, 3), 'secrets', ...good.slice(4)], [...good.slice(0, 5), 'wipe', good[6]], [...good.slice(0, 6), '{not json'], [...good.slice(0, 4), 'other-id', ...good.slice(5)], [good[0], 'not-a-stamp', ...good.slice(2)], [...good.slice(0, 2), 'other-device', ...good.slice(3)]]) assert.equal(S.fromRow(bad), null);
 assert.throws(() => S.toRow(S.createEvent(c, 'records', 'put', {...feed('big'), memo: 'x'.repeat(50000)}, 2000)), /너무 길어/);
});

function phone(device, backend, storage = memoryStore(), now = () => 1000) { return new S.SyncEngine({device, backend, storage, now}); }

test('two phones meet through the sheet', async () => {
 const sheet = new S.MemoryBackend(), a = phone('a', sheet), b = phone('b', sheet);
 a.change('records', 'put', feed('from-a'));
 b.change('schedule', 'put', {id: 'from-b', date: '2026-11-20T09:00', title: '접종'});
 await a.sync(); await b.sync(); await a.sync();
 assert.deepEqual(a.state(), b.state());
 assert.deepEqual([a.state().records.length, a.state().schedule.length], [1, 1]);
 assert.equal(sheet.rows.length, 2);
});

test('a change shows on its own phone before any sync, even offline', async () => {
 const sheet = new S.MemoryBackend(), a = phone('a', sheet);
 sheet.read = async () => { throw Error('offline'); };
 a.change('records', 'put', feed('x'));
 assert.equal(a.state().records.length, 1);
 await assert.rejects(a.sync());
 assert.equal(a.outbox.length, 1);
 assert.equal(a.state().records.length, 1);
});

test('a lost reply does not write the same change twice', async () => {
 const sheet = new S.MemoryBackend(), a = phone('a', sheet), append = sheet.append.bind(sheet);
 a.change('records', 'put', feed('x'));
 sheet.append = async rows => { await append(rows); throw Error('reply lost'); };
 await assert.rejects(a.sync());
 assert.equal(sheet.rows.length, 1);
 sheet.append = append;
 const result = await a.sync();
 assert.equal(sheet.rows.length, 1);
 assert.equal(result.waiting, 0);
});

test('a phone restarted mid-way carries on where it stopped', async () => {
 const sheet = new S.MemoryBackend(), storage = memoryStore(), a = phone('a', sheet, storage), other = phone('b', sheet);
 other.change('records', 'put', feed('old')); await other.sync();
 a.change('records', 'put', feed('mine'));
 const again = phone('a', sheet, storage);
 assert.equal(again.outbox.length, 1);
 await again.sync();
 assert.equal(again.state().records.length, 2);
 const stamp = again.change('records', 'put', feed('later')).stamp;
 assert.ok(stamp > again.log.at(-1).stamp);
});

test('a broken row in the sheet is counted and does not stop the others', async () => {
 const sheet = new S.MemoryBackend(), a = phone('a', sheet), b = phone('b', sheet);
 a.change('records', 'put', feed('x')); await a.sync();
 sheet.rows.push(['누가', '손으로', '적은', '줄']);
 a.change('records', 'put', feed('y')); await a.sync();
 const result = await b.sync();
 assert.equal(b.state().records.length, 2);
 assert.equal(result.skipped, 1);
});

test('many phones, flaky links, random order: everyone ends the same', async () => {
 for (let seed = 1; seed <= 25; seed++) {
  const r = random(seed * 7919), sheet = new S.MemoryBackend(), append = sheet.append.bind(sheet);
  let clock = 1000;
  sheet.append = async rows => {
   const roll = r(10);
   if (roll === 0) throw Error('failed before writing');
   await append(rows);
   if (roll === 1) throw Error('reply lost');
  };
  const phones = ['a', 'b', 'c'].map(d => phone(d, sheet, memoryStore(), () => clock + r(50)));
  for (let step = 0; step < 60; step++) {
   clock += r(5);
   const p = phones[r(3)], id = 'item' + r(6);
   if (r(3) === 0) await p.sync().catch(() => {});
   else if (r(4) === 0) p.change('records', 'delete', id);
   else p.change('records', 'put', feed(id, `${step}ml`));
  }
  sheet.append = append;
  for (let i = 0; i < 2; i++) for (const p of phones) await p.sync();
  assert.deepEqual(phones[0].state(), phones[1].state(), `seed ${seed}`);
  assert.deepEqual(phones[1].state(), phones[2].state(), `seed ${seed}`);
  assert.ok(phones.every(p => p.outbox.length === 0));
  assert.equal(new Set(sheet.rows.map(x => x[0])).size, sheet.rows.length, `seed ${seed}: no event written twice`);
 }
});

test('the Sheets adapter sends what Google expects and reports limits', async () => {
 const calls = [];
 const fetcher = async (url, options) => { calls.push({url, options}); return {ok: true, json: async () => ({values: [['a']]})}; };
 const sheet = new S.SheetsBackend({sheetId: 'abcDEF123_-xyz', token: async () => 'tok', fetcher});
 assert.deepEqual(await sheet.read(5), [['a']]);
 assert.match(calls[0].url, /\/spreadsheets\/abcDEF123_-xyz\/values\/.*A7%3AG/);
 assert.equal(calls[0].options.headers.Authorization, 'Bearer tok');
 const event = S.createEvent(new S.Clock('a'), 'records', 'put', feed('x'), 1000);
 await sheet.append([S.toRow(event)]);
 assert.match(calls[1].url, /:append\?valueInputOption=RAW&insertDataOption=INSERT_ROWS/);
 const sent = JSON.parse(calls[1].options.body).values[0];
 assert.equal(sent[0], event.event, 'RAW input needs no apostrophe');
 assert.deepEqual(S.fromRow(sent), event);
 const busy = new S.SheetsBackend({sheetId: 'abcDEF123_-xyz', token: async () => 'tok', fetcher: async () => ({ok: false, status: 429})});
 await assert.rejects(busy.read(0), e => e.retry === true && e.status === 429);
 assert.throws(() => new S.SheetsBackend({sheetId: '../evil', token: async () => ''}));
});

test('the running web app does not load this file yet', () => {
 const root = require('node:path').join(__dirname, '..');
 assert.doesNotMatch(fs.readFileSync(root + '/index.html', 'utf8'), /sync-core/);
 assert.doesNotMatch(fs.readFileSync(root + '/server.py', 'utf8'), /sync-core/);
});
