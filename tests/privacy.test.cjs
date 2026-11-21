'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {requirement, csvCell, recordsCsv, exportJson, VERSION} = require('../features/privacy.js');
const {browser, family} = require('./helpers/browser.cjs');

const feed = (id = 'a') => ({id, type: 'feeding', date: '2026-11-20T09:00', category: '분유', amount: '120ml', memo: ''});
const OTHER = {family: {home: false, name: '다른 가족'}};
// Another family's session: the harness signs in, then the family is set as the server would.
async function open({home = false, features = {privacy: 'all'}, modules = ['privacy'], server = family()} = {}) {
 const b = browser({features, modules, server});
 await b.login();
 if (!home) b.eval(`shared.family={home:false,name:'다른 가족'}`);
 b.eval("page='home';render()");
 return b;
}
const put = (b, item = feed()) => b.eval(`changeItem('records',${JSON.stringify(item)})`);
function tick(b, values) { for (const [id, on] of Object.entries(values)) b.get('#' + id).checked = on; }
const agree = async (b, aiOn = false) => { tick(b, {'consent-guardian': true, 'consent-health': true, 'consent-ai': aiOn}); await b.eval("SomhouseFeatures.click({dataset:{consent:'save'}})"); };

test('which requests need which consent', () => {
 for (const [path, method, body, need] of [['/api/items/records/a', 'PUT', {}, 'health'], ['/api/items/records/a', 'DELETE', undefined, 'health'], ['/api/timer', 'POST', {}, 'health'], ['/api/handoff', 'POST', {}, 'health'],
  ['/api/stock', 'POST', {}, 'health'], ['/api/review', 'POST', {}, 'health'], ['/api/confirm', 'POST', {}, 'health'], ['/api/merge', 'POST', {}, 'health'], ['/api/feature-data', 'POST', {feature: 'meds'}, 'health'],
  ['/api/ai', 'POST', {}, 'ai'], ['/api/chatgpt/ask', 'POST', {}, 'ai'],
  ['/api/feature-data', 'POST', {feature: 'privacy'}, ''], ['/api/data', 'GET', undefined, ''], ['/api/ai', 'GET', undefined, ''], ['/api/login', 'POST', {}, ''], ['/api/logout', 'POST', {}, ''], ['/api/family', 'POST', {}, ''], ['/api/password', 'POST', {}, '']]) {
  assert.equal(requirement(path, method, body), need, `${method} ${path}`);
 }
});

test('the operating family is not asked', async () => {
 const b = await open({home: true});
 assert.doesNotMatch(b.get('#content').innerHTML, /기록을 시작하기 전에/);
 assert.equal(await put(b), true);
});

test('with the feature off nothing changes for another family', async () => {
 const b = await open({features: {}, modules: []});
 assert.doesNotMatch(b.get('#content').innerHTML, /기록을 시작하기 전에/);
 assert.equal(await put(b), true);
});

test('another family cannot save before consenting, and can after', async () => {
 const b = await open();
 assert.match(b.get('#content').innerHTML, /기록을 시작하기 전에/);
 assert.equal(await put(b), false);
 assert.equal(b.server.data.records.length, 0);
 assert.match(b.alerts.at(-1), /동의해 주세요/);
 await agree(b);
 assert.doesNotMatch(b.get('#content').innerHTML, /기록을 시작하기 전에/);
 assert.equal(await put(b), true);
 assert.equal(b.server.data.records.length, 1);
});

test('both required boxes are needed; the AI box is optional', async () => {
 const b = await open();
 tick(b, {'consent-guardian': true, 'consent-health': false, 'consent-ai': true});
 await b.eval("SomhouseFeatures.click({dataset:{consent:'save'}})");
 assert.equal(b.eval("SomhouseFeatures.items('privacy').length"), 0);
 assert.match(b.get('#content').innerHTML, /필수 항목/);
 await agree(b, false);
 const [saved] = JSON.parse(b.eval("JSON.stringify(SomhouseFeatures.items('privacy'))"));
 assert.deepEqual([saved.guardian, saved.health, saved.ai, saved.version], [true, true, false, VERSION]);
});

test('AI requests wait for their own consent, whichever way they are sent', async () => {
 const b = await open();
 await agree(b, false);
 const calls = [];
 b.context.__calls = calls;
 b.eval("SomhouseAI.__real=1");
 assert.equal(b.eval('SomhouseConsent.has("ai")'), false);
 await assert.rejects(b.eval("aiDirect.ask('claude',{key:'k',model:'m'},'질문')"), /AI 전송에 동의/);
 await assert.rejects(b.eval("shared.askAI('질문','none','claude')"), /AI 전송에 동의/);
 await assert.rejects(b.eval("shared.request('/api/chatgpt/ask','POST',{question:'질문'})"), /AI 전송에 동의/);
 assert.equal(b.calls.filter(x => x.options.method === 'POST' && /\/api\/(ai|chatgpt)|anthropic/.test(x.url)).length, 0);
 b.eval("page='mydata';render()");
 await b.eval("SomhouseFeatures.click({dataset:{consent:'ai-on'}})");
 assert.equal(b.eval('SomhouseConsent.has("ai")'), true);
});

test('withdrawing stops new records but keeps what is stored', async () => {
 const b = await open();
 await agree(b);
 await put(b);
 b.context.location.hash = '#mydata'; b.eval('route()');
 assert.match(b.get('#content').innerHTML, /전체 동의 철회/);
 await b.eval("SomhouseFeatures.click({dataset:{consent:'withdraw'}})");
 assert.equal(b.eval("SomhouseFeatures.items('privacy').length"), 0);
 assert.equal(await put(b, feed('b')), false);
 assert.deepEqual(b.server.data.records.map(x => x.id), ['a']);
});

test('one member consenting does not consent for another', async () => {
 const b = await open();
 await agree(b);
 b.eval("shared.username='family2'");
 assert.equal(b.eval('SomhouseConsent.has("health")'), false);
});

test('consent to an older wording does not count', async () => {
 const b = await open();
 await b.eval(`SomhouseFeatures.save('privacy',{id:'consent:family1',user:'family1',version:'old',guardian:true,health:true,ai:true,at:'2026-01-01T00:00'})`);
 assert.equal(b.eval('SomhouseConsent.has("health")'), false);
});

test('a spreadsheet cannot be tricked into running a cell', () => {
 for (const bad of ['=1+1', '+1', '-1', '@x', '\tx']) assert.equal(csvCell(bad)[0] === "'" || csvCell(bad)[1] === "'", true, bad);
 assert.equal(csvCell('a,b'), '"a,b"');
 assert.equal(csvCell('말 "그대로"'), '"말 ""그대로"""');
 assert.equal(csvCell(undefined), '');
});

test('the export holds the whole family record', () => {
 const csv = recordsCsv([feed('b'), {...feed('a'), date: '2026-11-19T08:00', memo: '=SUM(1)'}]);
 assert.equal(csv.charCodeAt(0), 0xFEFF);
 const lines = csv.trim().split('\r\n');
 assert.equal(lines.length, 3);
 assert.match(lines[1], /2026-11-19T08:00/, 'oldest first');
 assert.match(lines[1], /'=SUM\(1\)/);
 const all = JSON.parse(exportJson({records: [feed()], schedule: [{id: 's'}], shopping: []}, {children: ['솜이'], features: {growth: [{id: 'g'}]}, token: 'x'}, '2026-11-21T10:00'));
 assert.deepEqual([all.records.length, all.schedule.length, all.settings.children[0], all.features.growth[0].id], [1, 1, '솜이', 'g']);
 assert.equal(all.token, undefined);
});
