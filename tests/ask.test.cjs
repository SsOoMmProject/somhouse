'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Somhouse = require('../service.js');
const {METRICS, understand, fromAI, compute, aiPrompt} = require('../features/ask.js');
const {browser, family} = require('./helpers/browser.cjs');

const TODAY = '2026-11-21', NOW = TODAY + 'T14:00'; // a Saturday
const feed = (date, amount = '120ml', category = '분유') => ({id: 'f' + date, type: 'feeding', date, category, amount, memo: ''});
const diaper = (date, category) => ({id: 'd' + date, type: 'diaper', date, category, memo: ''});
const sleep = (date, end, category = '낮잠') => ({id: 's' + date, type: 'sleep', date, end, category, memo: ''});
const answer = (question, records) => compute(understand(question, TODAY), records, NOW, Somhouse).text;

test('periods', () => {
 for (const [text, from, to, label] of [['오늘 수유', TODAY, TODAY, '오늘'], ['어제 수유', '2026-11-20', '2026-11-20', '어제'], ['그저께 수유', '2026-11-19', '2026-11-19', '그저께'],
  ['이번 주 수유', '2026-11-15', TODAY, '이번 주'], ['지난주 수유', '2026-11-08', '2026-11-14', '지난주'], ['최근 3일 수유', '2026-11-19', TODAY, '최근 3일'],
  ['이번 달 수유', '2026-11-01', TODAY, '이번 달'], ['지난달 수유', '2026-10-01', '2026-10-31', '지난달'], ['11월 3일 수유', '2026-11-03', '2026-11-03', '11월 3일'], ['12월 25일 수유', '2025-12-25', '2025-12-25', '12월 25일']]) {
  const q = understand(text, TODAY);
  assert.deepEqual([q.from, q.to, q.label], [from, to, label], text);
 }
});

test('what is being asked', () => {
 for (const [text, metric] of [['어제 수유 몇 번', 'feeding_count'], ['오늘 얼마나 먹었어', 'feeding_ml'], ['분유 총 몇 ml', 'feeding_ml'], ['직수 몇 분 했어', 'breast_minutes'], ['수유 간격', 'feed_gap'],
  ['마지막 수유 언제야', 'last_feeding'], ['어제 얼마나 잤어', 'sleep_total'], ['낮잠 몇 번', 'nap_count'], ['제일 길게 잔 잠', 'longest_sleep'], ['언제 잤어', 'last_sleep'],
  ['기저귀 몇 번', 'diaper_count'], ['대변 몇 번', 'poo_count'], ['응가 언제 했어', 'last_poo'], ['소변 몇 번', 'pee_count']]) {
  assert.equal(understand(text, TODAY).metric, metric, text);
 }
 assert.equal(understand('오늘 날씨 어때', TODAY), null);
 assert.equal(understand('밤잠 몇 시간', TODAY).part, '', '밤잠 is a kind of sleep, not the night hours');
 assert.equal(understand('어제 밤중 수유', TODAY).part, 'night');
 assert.equal(understand('지난주 평균 수유량', TODAY).average, true);
});

test('counts, totals and averages come from the records', () => {
 const records = [feed('2026-11-20T09:00'), feed('2026-11-20T12:00', '100ml'), feed('2026-11-20T15:00', '15분', '모유'), feed('2026-11-19T09:00'), feed(TODAY + 'T09:00'), feed(TODAY + 'T15:00')];
 assert.equal(answer('어제 수유 몇 번', records), '어제 수유는 3번이에요.');
 assert.equal(answer('어제 수유량', records), '어제 수유량은 모두 220ml이에요. (ml가 없는 1건은 빠졌어요)');
 assert.equal(answer('오늘 수유 몇 번', records), '오늘 수유는 1번이에요.', 'a record later than now is not counted');
 assert.equal(answer('최근 3일 평균 수유 횟수', records), '최근 3일 수유는 기록이 있는 3일 동안 하루 평균 1.7번이에요.');
 assert.equal(answer('어제 직수 몇 분', records), '어제 직수는 1번, 모두 15분이에요.');
 assert.equal(answer('어제 수유 간격', records), '어제 평균 수유 간격은 3시간이에요.');
 assert.equal(answer('마지막 수유 언제', records), '마지막 수유는 11월 21일 09:00, 분유 120ml이에요.');
});

test('night feedings of a day run into the next morning', () => {
 const records = [feed('2026-11-19T23:00'), feed('2026-11-20T03:00'), feed('2026-11-20T09:00'), feed('2026-11-20T23:30'), feed('2026-11-21T02:00'), feed('2026-11-21T07:00')];
 assert.equal(answer('어제 밤중 수유 몇 번', records), '어제 밤중 수유는 2번이에요.');
 assert.equal(answer('어제 새벽 수유 몇 번', records), '어제 새벽 수유는 1번이에요.');
 assert.equal(answer('어제 오전 수유 몇 번', records), '어제 오전 수유는 1번이에요.');
});

test('sleep and diapers', () => {
 const records = [sleep('2026-11-20T10:00', '2026-11-20T11:00'), sleep('2026-11-20T14:00', '2026-11-20T14:40'), sleep('2026-11-20T22:00', '2026-11-21T06:00', '밤잠'),
  diaper('2026-11-20T08:00', '소변'), diaper('2026-11-20T09:00', '대변'), diaper('2026-11-20T10:00', '둘 다')];
 assert.equal(answer('어제 낮잠 몇 번', records), '어제 낮잠은 2번이에요.');
 assert.equal(answer('어제 잠 얼마나', records), '어제 수면은 3시간 40분이에요.', 'only the part of the night that fell on that day');
 assert.equal(answer('어제 제일 길게 잔 잠', records), '어제 가장 긴 잠은 8시간이에요.');
 assert.equal(answer('어제 대변 몇 번', records), '어제 대변은 2번이에요.');
 assert.equal(answer('어제 소변 몇 번', records), '어제 소변은 2번이에요.');
 assert.equal(answer('어제 기저귀 몇 번', records), '어제 기저귀는 3번이에요.');
 assert.equal(answer('마지막 대변 언제', records), '마지막 대변은 11월 20일 10:00이에요.');
});

test('nothing recorded is said plainly', () => {
 assert.equal(answer('어제 수유량', []), '어제에는 ml로 적은 수유 기록이 없어요.');
 assert.equal(answer('어제 잠 얼마나', []), '어제에는 수면 기록이 없어요.');
 assert.equal(answer('마지막 수유 언제', []), '수유 기록이 없어요.');
});

test('an AI answer is only a query, and a bad one is refused', () => {
 assert.deepEqual(fromAI({metric: 'feeding_count', from: '2026-11-01', to: '2026-11-10', part: 'night', average: true}, TODAY),
  {metric: 'feeding_count', from: '2026-11-01', to: '2026-11-10', label: '2026-11-01 ~ 2026-11-10', part: 'night', average: true});
 for (const bad of [null, {}, {metric: 'drop_table', from: TODAY, to: TODAY}, {metric: 'constructor', from: TODAY, to: TODAY}, {metric: 'poo_count', from: '2026-13-01', to: TODAY},
  {metric: 'poo_count', from: TODAY, to: '2026-11-01'}, {metric: 'poo_count', from: TODAY, to: '2026-12-01'}, {metric: 'poo_count', from: '2020-01-01', to: TODAY},
  {metric: 'poo_count', from: TODAY, to: TODAY, part: 'lunch'}]) assert.equal(fromAI(bad, TODAY), null);
});

test('the prompt holds the question and the list of queries, and no records', () => {
 const prompt = aiPrompt('우리 아기 요즘 많이 먹어?', TODAY);
 assert.match(prompt, /우리 아기 요즘 많이 먹어/);
 for (const id of Object.keys(METRICS)) assert.ok(prompt.includes(id));
 assert.ok(aiPrompt('가'.repeat(1000), TODAY).length < 1200);
});

const local = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T00:00`; };

test('in the app a common question is answered with no request at all', async () => {
 const b = browser({features: {ask: 'all'}, modules: ['ask'], server: {...family(), data: {records: [{id: 'a', type: 'feeding', date: local(), category: '분유', amount: '120ml', memo: '비밀메모'}], schedule: [], shopping: []}}});
 await b.login();
 b.eval("page='stats';render()");
 b.events.get('input')({target: {dataset: {askInput: '1'}, value: '오늘 수유 몇 번'}});
 const before = b.calls.length;
 await b.eval("SomhouseFeatures.click({dataset:{askRun:'1'}})");
 assert.equal(b.calls.length, before);
 assert.match(b.get('#content').innerHTML, /오늘 수유는 1번이에요/);
 assert.match(b.get('#content').innerHTML, /아무 데도 보내지 않았어요/);
});

test('a harder question sends only its words to the connected AI, and the count is local', async () => {
 const b = browser({features: {ask: 'all'}, modules: ['ask'], server: {...family(), data: {records: [{id: 'a', type: 'feeding', date: local(), category: '분유', amount: '120ml', memo: '비밀메모'}], schedule: [], shopping: []}}});
 await b.login();
 const sent = [];
 b.context.__sent = sent;
 const today = local().slice(0, 10);
 b.eval(`aiHelpOption=()=>({mode:'key',p:{id:'claude',name:'Claude'},key:{}});aiName=()=>'Claude';aiHelpAsk=async(p,q)=>{__sent.push(q);return JSON.stringify({metric:'feeding_count',from:'${today}',to:'${today}',part:'',average:false});};page='stats';render();`);
 b.events.get('input')({target: {dataset: {askInput: '1'}, value: '우리 애기 오늘 젖병 몇 번 물었니'}});
 await b.eval("SomhouseFeatures.click({dataset:{askRun:'1'}})");
 assert.equal(sent.length, 1);
 assert.doesNotMatch(sent[0], /비밀메모|120ml/);
 assert.match(b.get('#content').innerHTML, /수유는 1번이에요/);
 assert.match(b.get('#content').innerHTML, /기록은 보내지 않았어요/);
});

test('without an AI an unknown question gets a hint', async () => {
 const b = browser({features: {ask: 'all'}, modules: ['ask']});
 await b.login();
 b.eval("page='stats';render()");
 b.events.get('input')({target: {dataset: {askInput: '1'}, value: '오늘 날씨 어때'}});
 await b.eval("SomhouseFeatures.click({dataset:{askRun:'1'}})");
 assert.match(b.get('#content').innerHTML, /이해하지 못했어요/);
});
