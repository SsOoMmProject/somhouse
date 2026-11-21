'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {TOPICS, buildText} = require('../features/shareai.js');
const {browser, family} = require('./helpers/browser.cjs');

const week = over => ({from: '2026-11-14', to: '2026-11-20', days_with_records: 7, feedings_per_day: 8.1, measured_ml_per_day: 720, breastfeeding_minutes_per_day: null, sleep_hours_per_day: 13.5, diapers_per_day: 7.2, poo_per_day: 1.4, ...over});
const numbers = {this_week: week(), last_week: week({from: '2026-11-07', to: '2026-11-13', days_with_records: 5, feedings_per_day: 7.5})};
const pad = n => String(n).padStart(2, '0'), stamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const yesterday = (h, m = 0) => { const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(h, m, 0, 0); return stamp(d); };

test('the text has both weeks, the question and the safety line', () => {
 const text = buildText('visit', '', numbers);
 assert.match(text, /최근 7일 \(2026-11-14 ~ 2026-11-20, 기록이 있는 날 7일\): 하루 평균 수유 8.1회, 분유 720ml, 수면 13.5시간, 기저귀 7.2회, 대변 1.4회/);
 assert.match(text, /그 전 7일 \(2026-11-07 ~ 2026-11-13, 기록이 있는 날 5일\)/);
 assert.ok(text.includes(TOPICS.visit.ask));
 assert.match(text, /진단이나 처방은 하지 마세요/);
 assert.doesNotMatch(text, /직수/, 'a kind with no records is left out');
});

test('a typed question replaces the topic and is cut to length', () => {
 const text = buildText('week', ' 밤중 수유를 줄여도 될까요? ', numbers);
 assert.match(text, /질문: 밤중 수유를 줄여도 될까요\?\n/);
 assert.ok(!text.includes(TOPICS.week.ask));
 assert.ok(buildText('week', '가'.repeat(5000), numbers).length < 1000);
});

async function withRecords(over = {}) {
 const records = [
  {id: 'a', type: 'feeding', date: yesterday(9), category: '분유', amount: '120ml', memo: '비밀메모-해열제 먹임'},
  {id: 'b', type: 'hospital', date: yesterday(11), hospital: '비밀소아과', reason: '비밀사유', memo: ''},
  {id: 'c', type: 'diaper', date: yesterday(12), category: '대변', memo: ''},
 ];
 const server = {...family(), data: {records, schedule: [], shopping: []}, settings: {children: ['비밀아기이름']}};
 const b = browser({features: {shareai: 'all'}, modules: ['shareai'], server, ...over});
 await b.login();
 b.eval("page='stats';render()");
 return b;
}

test('nothing personal goes into what is sent', async () => {
 const b = await withRecords();
 const text = b.eval("buildShare=SomhouseShareAI.buildText('week','',aiWeekNumbers())");
 assert.match(text, /수유 0.1회/);
 assert.doesNotMatch(text, /비밀/);
 assert.doesNotMatch(b.get('#content').innerHTML.match(/share-preview[\s\S]*?<\/pre>/)[0], /비밀/);
});

test('the phone share sheet gets exactly what the preview shows', async () => {
 const b = await withRecords(), sent = [];
 b.context.navigator = {share: async x => sent.push(x)};
 b.eval("render()");
 assert.match(b.get('#content').innerHTML, /앱으로 보내기/);
 assert.equal(await b.eval("SomhouseFeatures.click({dataset:{shareTopic:'visit'}})"), true);
 await b.eval("SomhouseFeatures.click({dataset:{shareSend:'1'}})");
 assert.equal(sent.length, 1);
 assert.ok(sent[0].text.includes(TOPICS.visit.ask));
 assert.deepEqual(Object.keys(sent[0]), ['text'], 'no link or file goes along');
 assert.match(b.get('#content').innerHTML, /앱으로 보냈어요/);
});

test('without a share sheet it copies, and a cancelled share is silent', async () => {
 const b = await withRecords(), copied = [];
 b.context.navigator = {clipboard: {writeText: async x => copied.push(x)}};
 b.eval("render()");
 assert.match(b.get('#content').innerHTML, /복사하기/);
 await b.eval("SomhouseFeatures.click({dataset:{shareSend:'1'}})");
 assert.equal(copied.length, 1);
 assert.match(b.get('#content').innerHTML, /복사했어요/);
 b.context.navigator = {share: async () => { const e = Error('x'); e.name = 'AbortError'; throw e; }};
 b.eval("SomhouseFeatures.click({dataset:{shareTopic:'sleep'}})");
 await b.eval("SomhouseFeatures.click({dataset:{shareSend:'1'}})");
 assert.doesNotMatch(b.get('#content').innerHTML, /보내지 못했어요/);
});

test('no card without records or for the guest', async () => {
 const b = browser({features: {shareai: 'all'}, modules: ['shareai']});
 await b.login();
 b.eval("page='stats';render()");
 assert.doesNotMatch(b.get('#content').innerHTML, /내 AI 앱에 물어보기/);
 const guest = browser({features: {shareai: 'all'}, modules: ['shareai'], server: {...family(), readOnly: true, data: {records: [{id: 'a', type: 'feeding', date: yesterday(9), category: '분유', amount: '120ml'}], schedule: [], shopping: []}}});
 await guest.login('guest');
 guest.eval("page='stats';render()");
 assert.doesNotMatch(guest.get('#content').innerHTML, /내 AI 앱에 물어보기/);
});
