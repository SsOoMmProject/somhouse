'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {parse, normalize} = require('../features/quicktext.js');
const {browser} = require('./helpers/browser.cjs');

const NOW = '2026-11-21T14:00';
const one = (text, records = [], now = NOW) => { const list = parse(text, now, records); assert.equal(list.length, 1, text); return list[0]; };
const pick = x => { const {type, date, end, category, amount} = x.record; return {type, date, ...(end ? {end} : {}), category, ...(amount !== undefined ? {amount} : {})}; };

test('the example sentence becomes a feeding and a sleep, moving forward in time', () => {
 const list = parse('새벽 3시 분유 120 먹고 4시에 잠', NOW);
 assert.deepEqual(list.map(pick), [
  {type: 'feeding', date: '2026-11-21T03:00', category: '분유', amount: '120ml'},
  {type: 'sleep', date: '2026-11-21T04:00', category: '밤잠'},
 ]);
 assert.ok(list.every(x => !x.problems.length));
});

test('feedings: kinds, units and spoken forms', () => {
 for (const [text, category, amount] of [['분유 120', '분유', '120ml'], ['분유 120미리', '분유', '120ml'], ['분유 150 밀리리터 먹었어', '분유', '150ml'],
  ['혼합 100cc', '혼합', '100ml'], ['모유 15분', '모유', '15분'], ['직수 20분 했어', '모유', '20분'], ['젖 10분', '모유', '10분'], ['모유 80ml', '모유', '80ml']]) {
  const x = one(text);
  assert.deepEqual([x.record.type, x.record.category, x.record.amount, x.record.date], ['feeding', category, amount, NOW], text);
  assert.deepEqual(x.problems, [], text);
 }
});

test('a feeding with no amount is flagged, never guessed', () => {
 const x = one('분유 먹었어');
 assert.equal(x.record.amount, '');
 assert.deepEqual(x.problems, ['양을 입력해 주세요']);
 assert.equal(one('모유 먹임').record.amount, '');
});

test('a feeding with no stated kind follows what the family usually writes and says so', () => {
 const records = [{type: 'feeding', date: '2026-11-21T09:00', category: '혼합', amount: '100ml'}];
 const x = one('수유 120ml', records);
 assert.equal(x.record.category, '혼합');
 assert.match(x.notes.join(), /혼합로 넣었어요/);
 assert.equal(one('수유 15분').record.category, '모유');
});

test('times: relative, parts of the day, half hours and clock format', () => {
 for (const [text, date] of [['10분 전 분유 100', '2026-11-21T13:50'], ['2시간 전 분유 100', '2026-11-21T12:00'], ['1시간 30분 전 분유 100', '2026-11-21T12:30'],
  ['오전 9시 분유 100', '2026-11-21T09:00'], ['아침 7시 반 분유 100', '2026-11-21T07:30'], ['낮 12시 분유 100', '2026-11-21T12:00'],
  ['오후 1시 20분 분유 100', '2026-11-21T13:20'], ['13:45 분유 100', '2026-11-21T13:45'], ['세시 반 분유 100', '2026-11-21T03:30'],
  ['어제 밤 11시 분유 100', '2026-11-20T23:00'], ['어제 오후 3시 분유 100', '2026-11-20T15:00'], ['그저께 오전 8시 분유 100', '2026-11-19T08:00']]) {
  assert.equal(one(text).record.date, date, text);
 }
});

test('an hour with no part of the day means the latest past one', () => {
 assert.equal(one('2시 분유 100', [], '2026-11-21T14:30').record.date, '2026-11-21T14:00');
 assert.equal(one('2시 분유 100', [], '2026-11-21T13:30').record.date, '2026-11-21T02:00');
 assert.equal(one('11시 분유 100', [], '2026-11-21T01:00').record.date, '2026-11-20T23:00');
 assert.equal(one('12시 분유 100', [], '2026-11-21T01:00').record.date, '2026-11-21T00:00');
 assert.equal(one('밤 12시 분유 100', [], '2026-11-21T01:00').record.date, '2026-11-21T00:00');
 assert.equal(one('밤 2시 분유 100', [], '2026-11-21T05:00').record.date, '2026-11-21T02:00');
});

test('a time later than now is flagged when the day was said, and moved back with a note when it was not', () => {
 assert.deepEqual(one('오늘 오후 5시 분유 100').problems, ['지금보다 늦은 시각이에요']);
 const moved = one('오후 5시 분유 100');
 assert.equal(moved.record.date, '2026-11-20T17:00');
 assert.deepEqual(moved.problems, []);
 assert.match(moved.notes.join(), /11\/20 17:00로 넣었어요/);
 assert.deepEqual(one('오후 2시 5분 분유 100').problems, [], 'a few minutes ahead is a clock difference');
});

test('sleep: length, start and end, kinds and waking up', () => {
 assert.deepEqual(pick(one('낮잠 40분')), {type: 'sleep', date: '2026-11-21T13:20', end: NOW, category: '낮잠'});
 assert.match(one('낮잠 40분').notes.join(), /방금 깬/);
 assert.deepEqual(pick(one('오전 10시 낮잠 1시간 30분')), {type: 'sleep', date: '2026-11-21T10:00', end: '2026-11-21T11:30', category: '낮잠'});
 assert.equal(one('밤 9시 잠').record.category, '밤잠');
 assert.equal(one('오후 1시 잠들었어').record.category, '낮잠');
 const list = parse('오전 10시 잠들고 11시에 깼어', NOW);
 assert.equal(list.length, 1);
 assert.deepEqual(pick(list[0]), {type: 'sleep', date: '2026-11-21T10:00', end: '2026-11-21T11:00', category: '낮잠'});
});

test('"깼어" ends the sleep that is still open', () => {
 const open = {id: 's1', type: 'sleep', date: '2026-11-21T12:30', end: '', category: '낮잠', memo: ''};
 const x = one('방금 깼어', [open]);
 assert.equal(x.record.id, 's1');
 assert.equal(x.record.end, NOW);
 const none = one('방금 깼어');
 assert.deepEqual(none.problems, ['잠든 시각을 확인해 주세요']);
});

test('diapers', () => {
 for (const [text, category] of [['소변', '소변'], ['쉬 했어', '소변'], ['응가', '대변'], ['똥 쌌어', '대변'], ['대변 소변 둘 다', '둘 다'], ['쉬랑 응가', '둘 다']]) {
  assert.deepEqual([one(text).record.type, one(text).record.category], ['diaper', category], text);
 }
 assert.deepEqual(one('기저귀 갈았어').problems, ['종류를 골라 주세요']);
 assert.equal(one('10분 전 응가').record.date, '2026-11-21T13:50');
});

test('several things in one line', () => {
 const list = parse('아침 7시 분유 140, 8시에 응가, 9시 낮잠 1시간', NOW);
 assert.deepEqual(list.map(x => [x.record.type, x.record.date]), [['feeding', '2026-11-21T07:00'], ['diaper', '2026-11-21T08:00'], ['sleep', '2026-11-21T09:00']]);
});

test('words that are not records stay out', () => {
 for (const text of ['', '안녕하세요', '오늘 날씨 좋다', '내일 3시 소아과 예약']) assert.deepEqual(parse(text, NOW), [], text);
});

test('long input is cut before parsing', () => {
 assert.ok(normalize('분유 '.repeat(500)).length <= 200);
});

test('nothing is saved until a person presses save', async () => {
 const b = browser({features: {quicktext: 'home'}, modules: ['quicktext']});
 await b.login();
 b.eval("page='home';render()");
 assert.match(b.get('#content').innerHTML, /한 줄로 기록/);
 b.eval(`SomhouseFeatures.click({dataset:{qtRead:'1'}})`);
 assert.match(b.get('#content').innerHTML, /기록할 내용을 적어 주세요/);
 b.eval(`document.dispatch=null`);
 const input = b.events.get('input');
 input({target: {dataset: {qtInput: '1'}, value: '10분 전 분유 120 먹고 방금 쉬'}});
 await b.eval(`SomhouseFeatures.click({dataset:{qtRead:'1'}})`);
 assert.equal(b.server.data.records.length, 0);
 assert.match(b.get('#content').innerHTML, /2건 저장/);
 await b.eval(`SomhouseFeatures.click({dataset:{qtSave:'1'}})`);
 assert.deepEqual(b.server.data.records.map(x => x.type).sort(), ['diaper', 'feeding']);
 assert.match(b.get('#content').innerHTML, /2건 저장했어요/);
});

test('an item with a problem cannot be saved without being fixed', async () => {
 const b = browser({features: {quicktext: 'home'}, modules: ['quicktext']});
 await b.login();
 b.eval("page='home';render()");
 b.events.get('input')({target: {dataset: {qtInput: '1'}, value: '분유 먹었어'}});
 await b.eval(`SomhouseFeatures.click({dataset:{qtRead:'1'}})`);
 assert.doesNotMatch(b.get('#content').innerHTML, /건 저장<\/button>/);
 await b.eval(`SomhouseFeatures.click({dataset:{qtSave:'1'}})`);
 assert.equal(b.server.data.records.length, 0);
});

test('the guest does not get the card', async () => {
 const b = browser({features: {quicktext: 'all'}, modules: ['quicktext'], server: {...require('./helpers/browser.cjs').family(), readOnly: true}});
 await b.login('guest');
 b.eval("page='home';render()");
 assert.doesNotMatch(b.get('#content').innerHTML, /한 줄로 기록/);
});
