'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {nextAt, tooSoon, latest, checkMed, checkTemp} = require('../features/meds.js');
const {browser, family} = require('./helpers/browser.cjs');

const med = (at, over = {}) => ({id: 'm' + at, kind: 'med', name: '해열제', dose: '3ml', every: '6', at, by: 'family1', ...over});
const NOW = '2026-11-21T14:00';

test('the next time comes only from the interval the family wrote', () => {
 assert.equal(nextAt(med('2026-11-21T10:00')), '2026-11-21T16:00');
 assert.equal(nextAt(med('2026-11-21T22:00', {every: '4'})), '2026-11-22T02:00');
 assert.equal(nextAt(med('2026-11-21T10:00', {every: ''})), '');
 assert.equal(nextAt(med('2026-11-21T10:00', {every: 'x'})), '');
});

test('a second dose inside the interval is caught, across spaces and case', () => {
 const list = [med('2026-11-21T10:00', {name: '타이레놀 시럽'})];
 const soon = tooSoon(list, '타이레놀시럽', NOW);
 assert.equal(soon.next, '2026-11-21T16:00');
 assert.equal(soon.agoMinutes, 240);
 assert.equal(tooSoon(list, '타이레놀시럽', '2026-11-21T16:00'), null, 'the interval has passed');
 assert.equal(tooSoon(list, '유산균', NOW), null, 'another medicine');
 assert.equal(tooSoon([med('2026-11-21T10:00', {every: ''})], '해열제', NOW), null, 'no interval, no guess');
});

test('the latest dose decides, and a dose after the moment is ignored', () => {
 const list = [med('2026-11-21T03:00'), med('2026-11-21T11:00'), med('2026-11-21T20:00')];
 assert.equal(tooSoon(list, '해열제', NOW).last.at, '2026-11-21T11:00');
});

test('current state per medicine', () => {
 const list = [med('2026-11-21T03:00'), med('2026-11-21T11:00'), med('2026-11-20T09:00', {name: '유산균', every: ''}), {id: 't', kind: 'temp', value: '37.5', at: '2026-11-21T12:00'}, med('2026-11-21T15:00', {name: '미래약'})];
 const state = latest(list, NOW);
 assert.deepEqual(state.map(x => x.entry.name), ['해열제', '유산균']);
 assert.deepEqual([state[0].wait, state[0].next, state[0].agoMinutes], [true, '2026-11-21T17:00', 180]);
 assert.equal(state[1].wait, false);
});

test('input is checked; nothing is judged', () => {
 const ok = {name: '해열제', dose: '3ml', every: '6', at: NOW};
 assert.equal(checkMed(ok, NOW), '');
 assert.equal(checkMed({...ok, dose: '', every: ''}, NOW), '');
 assert.match(checkMed({...ok, name: ' '}, NOW), /약 이름/);
 assert.match(checkMed({...ok, every: '0'}, NOW), /간격/);
 assert.match(checkMed({...ok, every: '100'}, NOW), /간격/);
 assert.match(checkMed({...ok, at: '2026-11-21T15:00'}, NOW), /늦은 시각/);
 assert.equal(checkTemp({value: '39.5', at: NOW}, NOW), '', 'any real temperature is simply recorded');
 assert.match(checkTemp({value: '3.7', at: NOW}, NOW), /체온/);
 assert.match(checkTemp({value: '', at: NOW}, NOW), /체온/);
});

const now = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const hoursAgo = h => { const d = new Date(Date.now() - h * 3600000), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
async function page(settings) {
 const b = browser({features: {meds: 'home'}, modules: ['meds'], server: {...family(), settings: {children: [], ...settings}}});
 await b.login();
 b.context.location.hash = '#meds'; b.eval('route()');
 return b;
}
const fields = (b, values) => { for (const [id, value] of Object.entries(values)) b.get('#' + id).value = value; };

test('a dose is saved for the whole family and shown on home', async () => {
 const b = await page();
 fields(b, {'med-name': '해열제', 'med-dose': '3ml', 'med-every': '6', 'med-at': now()});
 await b.eval("SomhouseFeatures.click({dataset:{medSave:'1'}})");
 const saved = b.server.settings.features.meds;
 assert.equal(saved.length, 1);
 assert.deepEqual([saved[0].name, saved[0].dose, saved[0].every, saved[0].by], ['해열제', '3ml', '6', 'family1']);
 b.context.location.hash = '#home'; b.eval('route()');
 assert.match(b.get('#content').innerHTML, /💊 해열제/);
 assert.match(b.get('#content').innerHTML, /적어 둔 간격 .*까지/);
 assert.doesNotMatch(b.get('#content').innerHTML, /기다려|먹이세요|먹여도/);
});

test('a repeat inside the interval asks first, and no means nothing is saved', async () => {
 const b = await page({features: {meds: [med(hoursAgo(1))]}});
 const asked = [];
 b.context.confirm = text => { asked.push(text); return false; };
 fields(b, {'med-name': '해열제', 'med-dose': '', 'med-every': '', 'med-at': now()});
 await b.eval("SomhouseFeatures.click({dataset:{medSave:'1'}})");
 assert.equal(asked.length, 1);
 assert.match(asked[0], /이미 기록했어요/);
 assert.equal(b.server.settings.features.meds.length, 1);
 b.context.confirm = () => true;
 fields(b, {'med-name': '해열제', 'med-dose': '', 'med-every': '', 'med-at': now()});
 await b.eval("SomhouseFeatures.click({dataset:{medSave:'1'}})");
 assert.equal(b.server.settings.features.meds.length, 2);
});

test('temperature is recorded without any verdict', async () => {
 const b = await page();
 await b.eval("SomhouseFeatures.click({dataset:{medTab:'temp'}})");
 fields(b, {'med-value': '39.8', 'med-at': now()});
 await b.eval("SomhouseFeatures.click({dataset:{medSave:'1'}})");
 assert.equal(b.server.settings.features.meds[0].value, '39.8');
 const html = b.get('#content').innerHTML;
 assert.match(html, /39.8℃/);
 assert.doesNotMatch(html, /고열|발열|위험|응급|정상|해열제를 먹/);
});

test('the screens never suggest a dose', async () => {
 const b = await page({features: {meds: [med(hoursAgo(2))]}});
 const html = b.get('#content').innerHTML;
 assert.match(html, /용량을 계산하거나 추천하지 않고/);
 assert.doesNotMatch(html, /mg\/kg|권장 용량|적정 용량/);
});

test('an entry can be removed', async () => {
 const entry = med(hoursAgo(2));
 const b = await page({features: {meds: [entry]}});
 await b.eval(`SomhouseFeatures.click({dataset:{medRemove:${JSON.stringify(entry.id)}}})`);
 assert.equal(b.server.settings.features, undefined);
});

test('other families do not get it until the gate is recorded', async () => {
 const b = browser({features: {meds: 'all'}, modules: ['meds']});
 await b.login();
 b.eval("shared.family={home:false,name:'다른 가족'};page='records';render()");
 assert.doesNotMatch(b.get('#content').innerHTML, /투약·체온 기록/);
 const open = browser({features: {meds: 'all'}, gates: {privacy: '2027-01-10 동의 화면 적용'}, modules: ['meds']});
 await open.login();
 open.eval("shared.family={home:false,name:'다른 가족'};page='records';render()");
 assert.match(open.get('#content').innerHTML, /투약·체온 기록/);
});
