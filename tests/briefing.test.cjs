'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
global.Somhouse = require('../service.js');
const {nextFeeding, nextNap, lastNight, minuteOf, stampOf} = require('../features/briefing.js');
const {browser, family} = require('./helpers/browser.cjs');

const at = (day, h, m = 0) => `2026-11-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
const feed = (date, amount = '120ml') => ({id: 'f' + date, type: 'feeding', date, category: '분유', amount, memo: ''});
const sleep = (date, end, category = '낮잠') => ({id: 's' + date, type: 'sleep', date, end, category, memo: ''});
const diaper = (date, category = '소변') => ({id: 'd' + date, type: 'diaper', date, category, memo: ''});
// A small repeatable random source, so "noisy" days are the same in every run.
function noise(seed) { let x = seed; return () => { x = (x * 16807) % 2147483647; return x / 2147483647; }; }

function everyThreeHours(lastDay, lastHour) {
 const out = [];
 for (let day = lastDay - 13; day <= lastDay; day++) for (let h = 0; h < 24; h += 3) if (day < lastDay || h <= lastHour) out.push(feed(at(day, h)));
 return out;
}

test('too few records make no prediction', () => {
 assert.equal(nextFeeding([], at(21, 14)), null);
 assert.equal(nextFeeding([feed(at(21, 9)), feed(at(21, 12))], at(21, 14)), null);
});

test('a regular baby: the next feeding, a tight range and a perfect self-test', () => {
 const x = nextFeeding(everyThreeHours(21, 12), at(21, 13));
 assert.equal(x.at, at(21, 15));
 assert.equal(x.length, 180);
 assert.ok(minuteOf(x.from) < minuteOf(x.at) && minuteOf(x.to) > minuteOf(x.at));
 assert.equal(x.hits, x.total);
 assert.ok(x.total >= 5);
 assert.equal(x.level, 'high');
 assert.equal(x.late, false);
});

test('the gap depends on the time of day', () => {
 const records = [];
 for (let day = 8; day <= 21; day++) for (const [h, m] of [[0, 0], [5, 0], [8, 0], [10, 30], [13, 0], [15, 30], [18, 0], [20, 30]]) {
  if (day < 21 || h <= 13) records.push(feed(at(day, h, m)));
 }
 assert.equal(nextFeeding(records, at(21, 14)).at, at(21, 15, 30), 'afternoon gaps are 2.5 hours');
 const night = records.filter(x => x.date <= at(21, 0));
 assert.equal(nextFeeding(night, at(21, 1)).at, at(21, 5), 'night gaps are 5 hours');
});

test('the self-test uses only what was known at the time', () => {
 // Three-hour gaps for 10 days, then two-hour gaps: the old pattern cannot have known the change.
 const records = [];
 for (let day = 8; day <= 17; day++) for (let h = 0; h < 24; h += 3) records.push(feed(at(day, h)));
 for (let day = 18; day <= 21; day++) for (let h = 0; h < 24; h += 2) if (day < 21 || h <= 12) records.push(feed(at(day, h)));
 const x = nextFeeding(records, at(21, 13));
 assert.ok(x.hits < x.total, `a look-ahead would score ${x.hits}/${x.total}`);
});

test('irregular days are reported as irregular', () => {
 const random = noise(7), records = [];
 let t = minuteOf(at(8, 0));
 while (t < minuteOf(at(21, 12))) { records.push(feed(stampOf(t))); t += 45 + Math.floor(random() * 420); }
 const x = nextFeeding(records, stampOf(t - 1));
 assert.ok(x, 'still gives a range');
 assert.notEqual(x.level, 'high');
});

test('top-ups a few minutes apart count as one feeding, and records in the future are ignored', () => {
 const records = everyThreeHours(21, 12);
 records.push(feed(at(21, 12, 10), '30ml'), feed(at(21, 18)));
 const x = nextFeeding(records, at(21, 13));
 assert.equal(x.at, at(21, 15, 10), 'counts from the end of the top-up');
});

test('no prediction after records stopped, and a passed time is marked', () => {
 const records = everyThreeHours(21, 3);
 assert.equal(nextFeeding(records, at(21, 12)), null);
 assert.equal(nextFeeding(records, at(21, 7)).late, true);
});

function napDays(lastDay, includeLast = true) {
 const out = [];
 for (let day = lastDay - 9; day <= lastDay; day++) {
  out.push(sleep(at(day, 9), at(day, 10)), sleep(at(day, 12), at(day, 13)));
  if (day < lastDay) out.push(sleep(at(day, 15, 30), at(day, 16, 30)));
 }
 return includeLast ? out : out.slice(0, -2);
}

test('the next nap follows the usual awake time', () => {
 const x = nextNap(napDays(21), at(21, 14));
 assert.equal(x.at, at(21, 15, 30), 'afternoon awake time is 2.5 hours');
 assert.equal(nextNap(napDays(21).slice(0, -1), at(21, 11)).at, at(21, 12));
});

test('no nap prediction while asleep, at night or without history', () => {
 assert.equal(nextNap([...napDays(21), sleep(at(21, 13, 30), '')], at(21, 14)), null);
 assert.equal(nextNap(napDays(21), at(21, 21)), null);
 assert.equal(nextNap([sleep(at(21, 9), at(21, 10))], at(21, 11)), null);
});

test('last night counts the hours from 19:00 to 07:00', () => {
 const records = [feed(at(20, 18)), feed(at(20, 22)), feed(at(21, 3), '100ml'), feed(at(21, 8)), diaper(at(21, 3, 5)),
  sleep(at(20, 20), at(21, 2)), sleep(at(21, 3, 30), at(21, 8))];
 const x = lastNight(records, at(21, 10));
 assert.deepEqual([x.from, x.to], [at(20, 19), at(21, 7)]);
 assert.deepEqual([x.feeds, x.ml, x.diapers], [2, 220, 1]);
 assert.equal(x.sleepMinutes, 360 + 210, 'a sleep past 07:00 counts only up to it');
 assert.equal(x.longest, 360);
 assert.equal(x.wakes, 1);
});

test('early in the morning last night runs until now, and an open sleep counts so far', () => {
 const x = lastNight([sleep(at(20, 21), '', '밤잠')], at(21, 5));
 assert.equal(x.to, at(21, 5));
 assert.equal(x.sleepMinutes, 480);
 assert.equal(lastNight([sleep(at(20, 21), '', '밤잠')], at(21, 20)), null, 'in the evening it is about tonight');
 assert.equal(lastNight([], at(21, 10)), null);
});

test('feedings without ml are counted but not added up', () => {
 const x = lastNight([feed(at(20, 23), '15분'), feed(at(21, 2), '90ml')], at(21, 9));
 assert.deepEqual([x.feeds, x.ml, x.mlCount], [2, 90, 1]);
});

test('the card appears on home, says what it is and makes no health claim', async () => {
 const now = new Date(), stamp = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
 const records = [];
 for (let i = 1; i <= 60; i++) records.push(feed(stamp(new Date(now.getTime() - i * 3 * 3600000))));
 const b = browser({features: {briefing: 'all'}, modules: ['briefing'], server: {...family(), data: {records, schedule: [], shopping: []}}});
 await b.login();
 b.eval("page='home';render()");
 const html = b.get('#content').innerHTML;
 assert.match(html, /오늘의 브리핑/);
 assert.match(html, /다음 수유/);
 assert.match(html, /±30분 안에 맞음/);
 assert.match(html, /건강 상태를 판단하지 않아요/);
 assert.doesNotMatch(html, /정상|비정상|위험|질환|의심/);
});

test('with no records there is no card', async () => {
 const b = browser({features: {briefing: 'all'}, modules: ['briefing']});
 await b.login();
 b.eval("page='home';render()");
 assert.doesNotMatch(b.get('#content').innerHTML, /오늘의 브리핑/);
});
