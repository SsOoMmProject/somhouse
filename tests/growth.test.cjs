'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../features/growth.js');
const {browser, family} = require('./helpers/browser.cjs');

// Published WHO values (month, 5th, 50th and 95th percentile).
const PUBLISHED = {
 '남 weight': [[0, 2.603994, 3.3464, 4.214527]],
 '여 weight': [[0, null, 3.2322, null]],
};

test('the table has every month from birth to 24 for both sexes', () => {
 for (const key of ['weight', 'length', 'head']) for (const sex of ['남', '여']) {
  assert.equal(G.LMS[key][sex].length, 25, `${key} ${sex}`);
  assert.ok(G.LMS[key][sex].every(row => row.length === 3 && row[1] > 0 && row[2] > 0));
 }
 assert.deepEqual(G.LMS.weight['남'][0], [0.3487, 3.3464, 0.14602]);
 assert.deepEqual(G.LMS.weight['여'][24], [-0.2941, 11.4775, 0.1239]);
 assert.deepEqual(G.LMS.length['남'][24], [1, 87.8161, 0.03479]);
 assert.deepEqual(G.LMS.head['여'][0], [1, 33.8787, 0.03496]);
});

test('published WHO percentiles come back', () => {
 const [, p5, p50, p95] = PUBLISHED['남 weight'][0];
 assert.ok(Math.abs(G.percentileOf('weight', '남', 0, p5) - 5) < 0.01);
 assert.ok(Math.abs(G.percentileOf('weight', '남', 0, p50) - 50) < 0.01);
 assert.ok(Math.abs(G.percentileOf('weight', '남', 0, p95) - 95) < 0.01);
 assert.ok(Math.abs(G.percentileOf('weight', '여', 0, 3.2322) - 50) < 0.01);
});

test('curves are the inverse of the percentile', () => {
 for (const [key, sex, month] of [['weight', '남', 7.5], ['length', '여', 13.2], ['head', '남', 22]]) for (const p of [3, 15, 50, 85, 97]) {
  const value = G.valueAt(key, sex, month, G.zFromPercentile(p));
  assert.ok(Math.abs(G.percentileOf(key, sex, month, value) - p) < 0.01, `${key} ${month} P${p}`);
 }
});

test('between two months the values are interpolated', () => {
 const a = G.lmsAt('weight', '남', 3), b = G.lmsAt('weight', '남', 4), mid = G.lmsAt('weight', '남', 3.5);
 assert.ok(Math.abs(mid[1] - (a[1] + b[1]) / 2) < 1e-9);
});

test('ages outside the table give no comparison rather than a wrong one', () => {
 assert.equal(G.percentileOf('weight', '남', 24.1, 12), null);
 assert.equal(G.percentileOf('weight', '남', -1, 12), null);
 assert.equal(G.percentileOf('weight', '', 6, 8), null);
 assert.equal(G.percentileOf('weight', '남', 6, 0), null);
 assert.notEqual(G.percentileOf('weight', '남', 24, 12), null);
});

test('extreme values read as below 1 or above 99', () => {
 assert.equal(G.percentText(0.2), '1 미만');
 assert.equal(G.percentText(99.5), '99 초과');
 assert.equal(G.percentText(42.4), '42');
});

test('entries are checked', () => {
 const check = (x, birth = '2026-06-01', today = '2026-11-21') => G.checkEntry({date: '2026-11-20', ...x}, birth, today);
 assert.equal(check({weight: '7.4'}), '');
 assert.equal(check({length: '66.2', head: '42.1'}), '');
 assert.match(check({}), /하나는/);
 assert.match(check({weight: '74'}), /몸무게/);
 assert.match(check({length: '6'}), /키/);
 assert.match(check({weight: '7', date: '2026-11-22'}), /측정한 날/);
 assert.match(check({weight: '7', date: '2026-02-30'}), /측정한 날/);
 assert.match(check({weight: '7', date: '2026-05-01'}), /태어난 날/);
});

const day = back => { const d = new Date(Date.now() - back * 86400000), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
async function page(features = {}) {
 const b = browser({features: {growth: 'home'}, modules: ['growth'], server: {...family(), settings: {children: ['솜이'], features}}});
 await b.login();
 b.context.location.hash = '#growth'; b.eval('route()');
 return b;
}
const profile = (over = {}) => ({id: 'p1', name: '솜이', birth: day(200), sex: '여', ...over});

test('the baby profile comes first', async () => {
 const b = await page();
 assert.match(b.get('#content').innerHTML, /fx-birth/);
 assert.doesNotMatch(b.get('#content').innerHTML, /growth-weight/);
});

test('a measurement is saved and shown against the standard, with no verdict', async () => {
 const b = await page({profile: [profile()]});
 b.get('#growth-date').value = day(0); b.get('#growth-weight').value = '7.4'; b.get('#growth-length').value = ''; b.get('#growth-head').value = '';
 await b.eval("SomhouseFeatures.click({dataset:{growthSave:'1'}})");
 const [saved] = b.server.settings.features.growth;
 assert.deepEqual([saved.child, saved.date, saved.weight, saved.length], ['p1', day(0), '7.4', undefined]);
 const html = b.get('#content').innerHTML;
 assert.match(html, /백분위 \d+/);
 assert.match(html, /<svg/);
 assert.match(html, /WHO 성장표준/);
 assert.doesNotMatch(html, /저체중|과체중|비만|정상|비정상|위험|성장 지연|발육/);
});

test('without a sex there are values but no comparison', async () => {
 const b = await page({profile: [profile({sex: undefined})], growth: [{id: 'g', child: 'p1', date: day(1), weight: '7.4'}]});
 const html = b.get('#content').innerHTML;
 assert.match(html, /7\.4kg/);
 assert.doesNotMatch(html, /백분위 \d/);
 assert.match(html, /성별을 넣으면/);
});

test('after 24 months it points to the national chart', async () => {
 const b = await page({profile: [profile({birth: day(900)})], growth: [{id: 'g', child: 'p1', date: day(1), weight: '13'}]});
 const html = b.get('#content').innerHTML;
 assert.match(html, /24개월까지만/);
 assert.doesNotMatch(html, /<svg/);
 assert.doesNotMatch(html, /백분위 \d/);
});

test('two babies keep their own measurements', async () => {
 const b = await page({profile: [profile(), profile({id: 'p2', name: '하늘', sex: '남'})], growth: [{id: 'a', child: 'p1', date: day(2), weight: '7.1'}, {id: 'b', child: 'p2', date: day(2), weight: '8.8'}]});
 assert.match(b.get('#content').innerHTML, /7\.1kg/);
 assert.doesNotMatch(b.get('#content').innerHTML, /8\.8kg/);
 await b.eval("SomhouseFeatures.click({dataset:{growthChild:'p2'}})");
 assert.match(b.get('#content').innerHTML, /8\.8kg/);
 assert.doesNotMatch(b.get('#content').innerHTML, /7\.1kg/);
});

test('the stats tab links to it and another family has to wait for the gate', async () => {
 const b = await page({profile: [profile()], growth: [{id: 'g', child: 'p1', date: day(1), weight: '7.4'}]});
 b.eval("page='stats';render()");
 assert.match(b.get('#content').innerHTML, /성장 기록/);
 b.eval("shared.family={home:false,name:'다른 가족'};render()");
 assert.doesNotMatch(b.get('#content').innerHTML, /성장 기록/);
});
