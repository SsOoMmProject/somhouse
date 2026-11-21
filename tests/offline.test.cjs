'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {browser, family} = require('./helpers/browser.cjs');

const QUEUE = 'somhouse-offline-queue-v1', COPY = 'somhouse-offline-copy-v1';
const feed = (id, date = '2026-11-20T09:00', amount = '120ml') => ({id, type: 'feeding', date, category: '분유', amount, memo: ''});
const open = (over = {}) => browser({features: {offline: 'all'}, modules: ['offline'], ...over});
const queued = b => JSON.parse(b.local.get(QUEUE) || '{}');
const count = b => Object.values(queued(b)).flat().filter(x => !x.rejected).length;
const down = b => b.fail(Error('network down')), up = b => { b.server.failure = null; };
const ids = b => JSON.parse(b.eval('JSON.stringify(data.records.map(x=>x.id))'));
async function change(b, item) { return b.eval(`changeItem('records',${JSON.stringify(item)})`); }

test('with the feature off a failed save is still an error', async () => {
 const b = browser();
 await b.login(); down(b);
 assert.equal(await change(b, feed('a')), false);
 assert.equal(b.local.has(QUEUE), false);
});

test('while connected a save goes straight to the server', async () => {
 const b = open();
 await b.login();
 assert.equal(await change(b, feed('a')), true);
 assert.equal(count(b), 0);
 assert.deepEqual(b.server.data.records.map(x => x.id), ['a']);
});

test('with no connection a save stays on the device, shows at once and is sent later', async () => {
 const b = open();
 await b.login(); down(b);
 assert.equal(await change(b, feed('a')), true);
 assert.equal(b.alerts.length, 0);
 assert.deepEqual(ids(b), ['a']);
 assert.equal(count(b), 1);
 assert.equal(b.server.data.records.length, 0);
 b.eval("page='home';render()");
 assert.match(b.get('#content').innerHTML, /기록 1건은 연결되면 자동으로 보내요/);
 up(b);
 await b.eval('refreshShared(true)');
 assert.equal(count(b), 0);
 assert.deepEqual(b.server.data.records.map(x => x.id), ['a']);
 assert.deepEqual(ids(b), ['a']);
 b.eval("page='home';render()");
 assert.doesNotMatch(b.get('#content').innerHTML, /연결되면 자동으로/);
});

test('changes keep their order, and a later edit or delete of the same record replaces the earlier one', async () => {
 const b = open();
 await b.login(); down(b);
 await change(b, feed('a')); await change(b, feed('b', '2026-11-20T10:00')); await change(b, feed('a', '2026-11-20T09:00', '150ml'));
 await b.eval("changeItem('records',{id:'b'},true)");
 assert.deepEqual(ids(b), ['a']);
 assert.equal(JSON.parse(b.eval("JSON.stringify(data.records[0].amount)")), '150ml');
 assert.equal(count(b), 2);
 up(b);
 await b.eval('refreshShared(true)');
 assert.deepEqual(b.server.data.records.map(x => [x.id, x.amount]), [['a', '150ml']]);
 assert.equal(count(b), 0);
});

test('records waiting on this device stay on screen when other changes arrive', async () => {
 const server = {...family(), data: {records: [feed('old', '2026-11-19T08:00')], schedule: [], shopping: []}};
 const b = open({server});
 await b.login(); down(b);
 await change(b, feed('mine', '2026-11-20T09:00'));
 // A second phone saved something; this phone's send fails only for writes.
 server.data.records.push(feed('other', '2026-11-20T08:00'));
 b.server.failure = null;
 const original = b.context.fetch;
 b.context.fetch = async (url, options) => { if (options.method === 'PUT') throw Error('write failed'); return original(url, options); };
 await b.eval('refreshShared(true)');
 assert.deepEqual(ids(b).sort(), ['mine', 'old', 'other']);
 assert.equal(count(b), 1);
});

test('a record the server refuses is set aside and does not block the rest', async () => {
 const b = open();
 await b.login(); down(b);
 await change(b, feed('bad')); await change(b, feed('good', '2026-11-20T10:00'));
 up(b);
 const original = b.context.fetch;
 b.context.fetch = async (url, options) => url.includes('/bad')
  ? {ok: false, status: 400, json: async () => ({error: '기록의 필수 항목을 확인해 주세요.'})} : original(url, options);
 await b.eval('refreshShared(true)');
 assert.deepEqual(b.server.data.records.map(x => x.id), ['good']);
 assert.equal(count(b), 0);
 assert.deepEqual(ids(b), ['good'], 'a refused record is not shown as saved');
 b.eval("page='home';render()");
 const html = b.get('#content').innerHTML, key = html.match(/data-offline-drop="([^"]+)"/)[1];
 assert.match(html, /서버가 받지 않은 기록/);
 assert.equal(await b.eval(`SomhouseFeatures.click({dataset:{offlineDrop:${JSON.stringify(key)}}})`), true);
 assert.equal(Object.keys(queued(b)).length, 0);
});

test('a server error keeps the save for later instead of losing it', async () => {
 const b = open();
 await b.login();
 const original = b.context.fetch;
 b.context.fetch = async (url, options) => options.method === 'PUT'
  ? {ok: false, status: 503, json: async () => ({error: '저장소에 접근하지 못했습니다.'})} : original(url, options);
 assert.equal(await change(b, feed('a')), true);
 assert.equal(count(b), 1);
 b.context.fetch = original;
 await b.eval('refreshShared(true)');
 assert.deepEqual(b.server.data.records.map(x => x.id), ['a']);
});

test('a refused save is an error right away, not queued', async () => {
 const b = open();
 await b.login();
 const original = b.context.fetch;
 b.context.fetch = async (url, options) => options.method === 'PUT'
  ? {ok: false, status: 400, json: async () => ({error: '기록의 필수 항목을 확인해 주세요.'})} : original(url, options);
 assert.equal(await change(b, feed('a')), false);
 assert.equal(count(b), 0);
 assert.deepEqual(ids(b), []);
});

test('a feeding saved offline ends the open sleep on screen, as the server will', async () => {
 const sleep = {id: 's', type: 'sleep', date: '2026-11-20T07:00', end: '', category: '낮잠', memo: ''};
 const b = open({server: {...family(), data: {records: [sleep], schedule: [], shopping: []}}});
 await b.login(); down(b);
 await change(b, feed('a', '2026-11-20T08:30'));
 assert.equal(b.eval("data.records.find(x=>x.id==='s').end"), '2026-11-20T08:30');
 assert.equal(b.server.data.records[0].end, '', 'the server is told only the feeding');
});

test('with no connection the screen opens from the last copy, and logout removes it', async () => {
 const local = new Map(), server = {...family(), data: {records: [feed('kept')], schedule: [], shopping: []}};
 const first = open({local, server});
 await first.login();
 assert.ok(local.has(COPY));
 const session = JSON.parse(first.local.get('somhouse-session-v1'));
 const second = open({local, session, server: {...family(), failure: Error('network down')}});
 await settle(second);
 assert.equal(second.eval('sharedReady'), true);
 assert.deepEqual(ids(second), ['kept']);
 second.server.failure = null;
 second.server.data = clone(server.data);
 await second.eval('shared.logout()');
 assert.equal(local.has(COPY), false);
});
function clone(x) { return JSON.parse(JSON.stringify(x)); }
// A page opened with a saved session starts loading before the feature file arrives; let that finish, then load through it.
async function settle(b) { await b.eval('refreshTask'); await b.settle(); await b.eval('refreshTask'); await b.eval('refreshShared(true)'); }

test('unsent saves survive a reload and belong to the account that made them', async () => {
 const local = new Map(), server = family();
 const first = open({local, server});
 await first.login('family1'); down(first);
 await change(first, feed('a'));
 const saved = local.get('somhouse-session-v1');
 server.failure = null;
 local.delete('somhouse-session-v1');
 const other = open({local, session: {...JSON.parse(saved), username: 'family2', token: 'other'}, server});
 await settle(other);
 assert.equal(other.eval('shared.username'), 'family2');
 assert.equal(server.data.records.length, 0, "another account must not send this account's saves");
 local.set('somhouse-session-v1', saved);
 const again = open({local, server});
 await settle(again);
 assert.deepEqual(server.data.records.map(x => x.id), ['a']);
});

test('the guest never queues anything', async () => {
 const b = open({server: {...family(), readOnly: true}});
 await b.login('guest'); down(b);
 assert.equal(await change(b, feed('a')), false);
 assert.equal(b.local.has(QUEUE), false);
});
