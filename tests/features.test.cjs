'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {browser, family} = require('./helpers/browser.cjs');
const host = require('../features.js');

const HOME = {home: true}, OTHER = {home: false};

test('nothing is on unless a deployment lists it', () => {
 for (const id of Object.keys(host.CATALOG)) {
  assert.equal(host.loadable(id, {}, {}), false);
  assert.equal(host.allowed(id, HOME, {}, {}), false);
 }
 assert.equal(host.loadable('offline', {offline: true}, {}), false, 'only home or all counts');
 assert.equal(host.loadable('not-a-feature', {'not-a-feature': 'all'}, {}), false);
 assert.equal(host.loadable('constructor', {constructor: 'all'}, {}), false);
});

test('home opens to the operating family only; all opens to everyone when there is no gate', () => {
 assert.equal(host.allowed('offline', HOME, {offline: 'home'}, {}), true);
 assert.equal(host.allowed('offline', OTHER, {offline: 'home'}, {}), false);
 assert.equal(host.allowed('offline', OTHER, {offline: 'all'}, {}), true);
});

test('a consent-gated feature reaches other families only after the gate is recorded', () => {
 const on = {meds: 'all'};
 assert.equal(host.allowed('meds', HOME, on, {}), true, 'the operating family can use it first');
 assert.equal(host.allowed('meds', OTHER, on, {}), false);
 assert.equal(host.allowed('meds', OTHER, on, {privacy: '   '}), false, 'a blank note does not clear a gate');
 assert.equal(host.allowed('meds', OTHER, on, {privacy: true}), false, 'the record must say what was done');
 assert.equal(host.allowed('meds', OTHER, on, {privacy: '2027-01-10 동의 화면 적용'}), true);
 assert.equal(host.allowed('meds', OTHER, {meds: 'home'}, {privacy: '2027-01-10 동의 화면 적용'}), false);
});

test('a regulated feature does not even load until its gate is recorded', () => {
 host.CATALOG.locked = {title: '시험', gate: 'regulated'};
 try {
  assert.equal(host.loadable('locked', {locked: 'home'}, {}), false);
  assert.equal(host.allowed('locked', HOME, {locked: 'all'}, {}), false);
  assert.equal(host.allowed('locked', HOME, {locked: 'home'}, {regulated: '2028-01-01 허가 제0000호'}), true);
 } finally { delete host.CATALOG.locked; }
});

test('with nothing turned on the app asks for no feature file and shows nothing extra', async () => {
 const added = [];
 const b = browser({server: {...family(), data: {records: [], schedule: [], shopping: []}}});
 b.context.document.head = {appendChild: x => added.push(x)};
 b.eval('SomhouseFeatures.start()');
 await b.login();
 assert.deepEqual(added, []);
 assert.equal(b.eval("SomhouseFeatures.slot('home')"), '');
 assert.equal(b.eval("SomhouseFeatures.page('anything')"), null);
});

test('a turned-on feature file is requested once', () => {
 const added = [], b = browser({features: {briefing: 'home'}});
 b.context.document.head = {appendChild: x => added.push(x)};
 b.eval("featureHost===SomhouseFeatures");
 // start() already ran at the end of app.js without a head element; a fresh host load picks it up.
 vm_reload(b);
 b.eval('SomhouseFeatures.start();SomhouseFeatures.start()');
 assert.equal(added.length, 1);
 assert.match(added[0].src, /^features\/briefing\.js\?v=/);
});
function vm_reload(b) { b.eval(fs.readFileSync(path.join(__dirname, '..', 'features.js'), 'utf8')); }

test('a feature adds cards and pages, and one that throws cannot break the screen', async () => {
 const b = browser({features: {briefing: 'all', shareai: 'all'}});
 await b.login();
 const quiet = b.context.console; b.context.console = {...quiet, error() {}};
 b.eval(`SomhouseFeatures.register({id:'briefing',slots:{home:()=>'<section id="fx-a">카드</section>'},pages:{fxpage:{title:'새 화면',view:()=>'<h1>새 화면 본문</h1>'}}});
  SomhouseFeatures.register({id:'shareai',slots:{home(){throw Error('broken')}}});page='home';render();`);
 assert.match(b.get('#content').innerHTML, /fx-a/);
 assert.match(b.get('#content').innerHTML, /우리 가족의 오늘/);
 b.context.location.hash = '#fxpage';
 b.eval('route()');
 assert.equal(b.eval('page'), 'fxpage');
 assert.match(b.get('#content').innerHTML, /새 화면 본문/);
 b.context.console = quiet;
});

test('one-hand recording stays above feature cards; only urgent notices go above it', async () => {
 const b = browser({features: {briefing: 'all', shareai: 'all'}});
 await b.login();
 b.eval(`SomhouseFeatures.register({id:'briefing',slots:{home:()=>'<section id="fx-card">카드</section>'}});
  SomhouseFeatures.register({id:'shareai',slots:{alert:()=>'<section id="fx-alert">알림</section>'}});page='home';render();`);
 const html = b.get('#content').innerHTML, at = text => html.indexOf(text);
 assert.ok(at('now-card') < at('fx-alert') && at('fx-alert') < at('data-add="feeding"') && at('data-add="feeding"') < at('fx-card'));
});

test('a file cannot switch itself on', async () => {
 const b = browser();
 await b.login();
 assert.equal(b.eval("SomhouseFeatures.register({id:'meds',slots:{home:()=>'<b>몰래</b>'}})"), false);
 b.eval("page='home';render()");
 assert.doesNotMatch(b.get('#content').innerHTML, /몰래/);
});

test('items are saved one at a time and removed for the family', async () => {
 const b = browser({features: {meds: 'home'}});
 await b.login();
 assert.equal(await b.eval("SomhouseFeatures.save('meds',{id:'a',name:'해열제'})"), true);
 assert.equal(await b.eval("SomhouseFeatures.save('meds',{id:'b',name:'유산균'})"), true);
 assert.equal(b.eval("SomhouseFeatures.items('meds').length"), 2);
 assert.equal(await b.eval("SomhouseFeatures.remove('meds','a')"), true);
 assert.deepEqual(JSON.parse(b.eval("JSON.stringify(SomhouseFeatures.items('meds').map(x=>x.id))")), ['b']);
});

test('age in months counts calendar months and short months roll back', () => {
 assert.deepEqual(host.ageOn('2026-01-31', '2026-02-27'), {days: 27, months: 0});
 assert.deepEqual(host.ageOn('2026-01-31', '2026-02-28'), {days: 28, months: 1});
 assert.deepEqual(host.ageOn('2026-03-15', '2026-04-14'), {days: 30, months: 0});
 assert.deepEqual(host.ageOn('2026-03-15', '2026-04-15'), {days: 31, months: 1});
 assert.deepEqual(host.ageOn('2024-02-29', '2026-02-28'), {days: 730, months: 24});
 assert.equal(host.ageOn('2026-03-15', '2026-03-14'), null);
 assert.equal(host.dayAtMonths('2026-01-31', 1), '2026-02-28');
 assert.equal(host.dayAtMonths('2026-01-15', 12), '2027-01-15');
 assert.equal(host.validDay('2026-02-30'), false);
 assert.equal(host.validDay('2026-02-28'), true);
});

test('the baby profile is saved for features that need an age', async () => {
 const b = browser({features: {growth: 'home'}});
 await b.login();
 assert.match(b.eval("SomhouseFeatures.profileCard('나이를 계산해요.',true)"), /fx-birth/);
 b.get('#fx-name').value = '솜이'; b.get('#fx-birth').value = '2026-08-01'; b.get('#fx-sex').value = '여';
 b.eval("page='home';void 0");
 assert.equal(await b.eval("SomhouseFeatures.click({dataset:{fxProfile:'save'}})"), true);
 const saved = JSON.parse(b.eval('JSON.stringify(SomhouseFeatures.profiles())'));
 assert.equal(saved.length, 1);
 assert.equal(saved[0].name, '솜이'); assert.equal(saved[0].birth, '2026-08-01'); assert.equal(saved[0].sex, '여');
 assert.match(b.eval("SomhouseFeatures.profileCard('x',true)"), /솜이 2026-08-01 · 여/);
});

test('a future birth date is refused', async () => {
 const b = browser({features: {growth: 'home'}});
 await b.login();
 b.eval("SomhouseFeatures.profileCard('x',true)");
 b.get('#fx-name').value = '솜이'; b.get('#fx-birth').value = '2999-01-01';
 await b.eval("SomhouseFeatures.click({dataset:{fxProfile:'save'}})");
 assert.equal(b.eval('SomhouseFeatures.profiles().length'), 0);
 assert.equal(b.alerts.length, 1);
});
