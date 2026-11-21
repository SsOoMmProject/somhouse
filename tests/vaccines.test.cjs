'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../features/vaccines.js');
const {browser, family} = require('./helpers/browser.cjs');

const BIRTH = '2026-05-15';
const find = (list, id) => list.find(x => x.id === id);
const when = (vaccine, choices) => V.plan(choices).filter(x => x.vaccine === vaccine).map(x => `${x.label} ${x.when}`);

test('every line of the 2026 national schedule', () => {
 assert.deepEqual(when('bcg'), ['1차 생후 4주 이내']);
 assert.deepEqual(when('hepb'), ['1차 출생 시', '2차 1개월', '3차 6개월']);
 assert.deepEqual(when('dtap'), ['1차 2개월', '2차 4개월', '3차 6개월', '4차 15~18개월', '5차 4~6세', '6차 11~12세']);
 assert.deepEqual(when('ipv'), ['1차 2개월', '2차 4개월', '3차 6~18개월', '4차 4~6세']);
 assert.deepEqual(when('hib'), ['1차 2개월', '2차 4개월', '3차 6개월', '4차 12~15개월']);
 assert.deepEqual(when('pcv'), ['1차 2개월', '2차 4개월', '3차 6개월', '4차 12~15개월']);
 assert.deepEqual(when('rv', {rv: 'rv1'}), ['1차 2개월', '2차 4개월']);
 assert.deepEqual(when('rv', {rv: 'rv5'}), ['1차 2개월', '2차 4개월', '3차 6개월']);
 assert.deepEqual(when('mmr'), ['1차 12~15개월', '2차 4~6세']);
 assert.deepEqual(when('var'), ['1차 12~15개월']);
 assert.deepEqual(when('hepa'), ['1차 12~35개월', '2차 12~35개월']);
 assert.deepEqual(when('je', {je: 'ijev'}), ['1차 12~23개월', '2차 12~23개월', '3차 24~35개월', '4차 6세', '5차 12세']);
 assert.deepEqual(when('je', {je: 'ljev'}), ['1차 12~23개월', '2차 24~35개월']);
 assert.deepEqual(when('hpv'), ['1차 11~12세', '2차 11~12세']);
});

test('until a product is chosen only the doses both products share are listed', () => {
 assert.deepEqual(when('rv'), ['1차 2개월', '2차 4개월']);
 assert.deepEqual(when('je'), ['1차 12~23개월']);
 assert.ok(V.plan().filter(x => x.vaccine === 'rv').every(x => x.pending));
 assert.ok(V.plan({rv: 'rv5'}).filter(x => x.vaccine === 'rv').every(x => !x.pending));
});

test('infant checkups and dental checkups', () => {
 assert.deepEqual(V.CHECKUPS.map(x => x.when), ['생후 14~35일', '4~6개월', '9~12개월', '18~24개월', '30~36개월', '42~48개월', '54~60개월', '66~71개월']);
 assert.deepEqual(V.DENTAL.map(x => x.when), ['18~29개월', '30~41개월', '42~53개월', '54~65개월']);
});

test('windows follow the birth date', () => {
 const list = V.schedule(BIRTH, '2026-11-21');
 assert.deepEqual([find(list, 'bcg-1').start, find(list, 'bcg-1').end], ['2026-05-15', '2026-06-12']);
 assert.deepEqual([find(list, 'hepb-3').start, find(list, 'hepb-3').end], ['2026-11-15', '2026-12-14']);
 assert.deepEqual([find(list, 'dtap-4').start, find(list, 'dtap-4').end], ['2027-08-15', '2027-12-14']);
 assert.deepEqual([find(list, 'mmr-2').start, find(list, 'mmr-2').end], ['2030-05-15', '2033-05-14']);
 assert.deepEqual([find(list, 'check-1').start, find(list, 'check-1').end], ['2026-05-29', '2026-06-19']);
 assert.deepEqual([find(list, 'check-2').start, find(list, 'check-2').end], ['2026-09-15', '2026-12-14']);
});

test('a birth on the 31st keeps real calendar days', () => {
 const list = V.schedule('2026-01-31', '2026-02-01');
 assert.equal(find(list, 'hepb-2').start, '2026-02-28');
 assert.equal(find(list, 'hepb-2').end, '2026-03-30');
});

test('status moves from later to soon to now to past, and done stays done', () => {
 const status = today => find(V.schedule(BIRTH, today), 'hepb-3').status;
 assert.equal(status('2026-10-01'), 'later');
 assert.equal(status('2026-10-16'), 'soon');
 assert.equal(status('2026-11-15'), 'now');
 assert.equal(status('2026-12-14'), 'now');
 assert.equal(status('2026-12-15'), 'past');
 assert.equal(find(V.schedule(BIRTH, '2026-12-15', new Set(['hepb-3'])), 'hepb-3').status, 'done');
});

const day = back => { const d = new Date(Date.now() - back * 86400000), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const profile = (over = {}) => ({id: 'p1', name: '솜이', birth: day(70), ...over});
async function page(features = {profile: [profile()]}, options = {}) {
 const b = browser({features: {vaccines: 'home'}, modules: ['vaccines'], server: {...family(), settings: {children: ['솜이'], features}}, ...options});
 await b.login();
 b.context.location.hash = '#vaccines'; b.eval('route()');
 return b;
}

test('it asks for the birth date first', async () => {
 const b = await page({});
 assert.match(b.get('#content').innerHTML, /fx-birth/);
});

test('the page cites the source, gives no verdict and sends delays to the doctor', async () => {
 const b = await page();
 const html = b.get('#content').innerHTML;
 assert.match(html, /질병관리청 2026년 표준예방접종일정표/);
 assert.match(html, /nip\.kdca\.go\.kr/);
 assert.match(html, /지금 시기/);
 assert.match(html, /의사와 상의/);
 assert.doesNotMatch(html, /(?<!고)위험|부작용|맞지 마|안 맞아도/);
});

test('marking done and undoing it are shared with the family', async () => {
 const b = await page();
 await b.eval("SomhouseFeatures.click({dataset:{vaxDone:'dtap-1'}})");
 assert.deepEqual(b.server.settings.features.vaccines.map(x => x.id), ['done:p1:dtap-1']);
 assert.match(b.get('#content').innerHTML, /완료 1건/);
 await b.eval("SomhouseFeatures.click({dataset:{vaxUndo:'dtap-1'}})");
 assert.equal(b.server.settings.features.vaccines, undefined);
});

test('choosing a product reveals its later doses', async () => {
 const b = await page();
 assert.doesNotMatch(b.get('#content').innerHTML, /로타바이러스 3차/);
 await b.eval("SomhouseFeatures.click({dataset:{vaxChoice:'rv:rv5'}})");
 assert.match(b.get('#content').innerHTML, /로타바이러스 3차/);
 await b.eval("SomhouseFeatures.click({dataset:{vaxChoice:'rv:nope'}})");
 assert.equal(b.server.settings.features.vaccines.length, 1);
});

test('a dose goes on the family schedule once', async () => {
 const b = await page();
 await b.eval("SomhouseFeatures.click({dataset:{vaxPlan:'dtap-1'}})");
 await b.eval("SomhouseFeatures.click({dataset:{vaxPlan:'dtap-1'}})");
 assert.equal(b.server.data.schedule.length, 1);
 const [item] = b.server.data.schedule;
 assert.equal(item.title, '예방접종: 디프테리아·파상풍·백일해 1차');
 assert.equal(item.who, '솜이');
 assert.ok(item.date >= day(0));
 assert.match(b.get('#content').innerHTML, /일정에 있어요/);
});

test('everything past can be marked at once after confirming', async () => {
 const b = await page({profile: [profile({birth: day(250)})]});
 b.context.confirm = () => false;
 await b.eval("SomhouseFeatures.click({dataset:{vaxAll:'1'}})");
 assert.equal(b.server.settings.features.vaccines, undefined);
 b.context.confirm = () => true;
 await b.eval("SomhouseFeatures.click({dataset:{vaxAll:'1'}})");
 assert.ok(b.server.settings.features.vaccines.length >= 5);
 assert.doesNotMatch(b.get('#content').innerHTML, /표준 시기 지남 \d+건/);
});

test('a family keeps track per baby', async () => {
 const b = await page({profile: [profile(), profile({id: 'p2', name: '하늘', birth: day(500)})]});
 await b.eval("SomhouseFeatures.click({dataset:{vaxDone:'hepb-1'}})");
 await b.eval("SomhouseFeatures.click({dataset:{vaxChild:'p2'}})");
 assert.doesNotMatch(b.get('#content').innerHTML, /완료 1건/);
 assert.deepEqual(b.server.settings.features.vaccines.map(x => x.id), ['done:p1:hepb-1']);
});

test('home shows what is coming, and another family waits for the gate', async () => {
 const b = await page();
 b.context.location.hash = '#home'; b.eval('route()');
 assert.match(b.get('#content').innerHTML, /다가오는 접종·검진/);
 b.eval("shared.family={home:false,name:'다른 가족'};render()");
 assert.doesNotMatch(b.get('#content').innerHTML, /다가오는 접종·검진/);
});
