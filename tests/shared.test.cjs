const {test}=require('node:test');
const assert=require('node:assert/strict');
const {serverURL}=require('../shared.js');
const {browser,family}=require('./helpers/browser.cjs');

test('API URL allows HTTPS and loopback only, with no credentials or path',()=>{
 assert.equal(serverURL('https://family.example/'),'https://family.example');
 assert.equal(serverURL('http://127.0.0.1:8787'),'http://127.0.0.1:8787');
 for(const url of ['http://family.example','https://user:pass@family.example','https://family.example/api','https://family.example?token=x','javascript:alert(1)'])assert.throws(()=>serverURL(url));
});

test('signed out users cannot create private device-only records',async()=>{
 const b=browser();assert.equal(b.eval('mode'),'login');
 assert.equal(await b.eval("changeItem('shopping',{id:'blocked',title:'차단',quantity:'1'})"),false);
 assert.equal(b.calls.length,0);assert.equal(b.get('nav').hidden,true);
});

test('shared save preserves device originals and failure preserves entered data',async()=>{
 const original=JSON.stringify({records:[],schedule:[],shopping:[{id:'device',title:'원본',quantity:'1'}]});
 const b=browser({raw:original});await b.login();
 assert.equal(await b.eval("changeItem('shopping',{id:'shared',title:'공유',quantity:'1'})"),true);
 assert.equal(b.local.get('somhouse-v1'),original);
 b.fail(Error('offline'));
 assert.equal(await b.eval("changeItem('shopping',{id:'shared',title:'실패',quantity:'1'})"),false);
 assert.equal(b.eval("data.shopping.find(x=>x.id==='shared').title"),'공유');
 assert.equal(b.local.get('somhouse-v1'),original);
 const call=b.calls.find(x=>x.options.method==='PUT');
 assert.equal(call.options.headers.Authorization,'Bearer test-token');assert.equal(call.options.credentials,'omit');
 assert.ok(b.local.has('somhouse-session-v1'));assert.ok(!b.sessionData.has('somhouse-session-v1'));
});

test('existing tab session becomes persistent without replacing local originals',async()=>{
 const b=browser({session:{base:'http://127.0.0.1:8787',token:'existing',username:'family2'}});
 const original=b.local.get('somhouse-v1');await b.settle();
 assert.equal(b.eval('mode'),'shared');assert.equal(b.eval('sharedReady'),true);
 assert.equal(b.local.get('somhouse-v1'),original);assert.equal(b.calls[0].options.headers.Authorization,'Bearer existing');
 assert.equal(b.sessionData.has('somhouse-session-v1'),false);
 const reopened=browser({local:b.local});await reopened.settle();
 assert.equal(reopened.eval('mode'),'shared');assert.equal(reopened.eval('sharedReady'),true);
 assert.equal(reopened.calls[0].options.headers.Authorization,'Bearer existing');
});

test('logout removes the persisted login and signs out other open tabs',async()=>{
 const b=browser();await b.login();
 const key='somhouse-session-v1',oldValue=b.local.get(key);
 const other=browser({local:b.local,server:b.server});await other.settle();
 assert.equal(other.get('#change-password').hidden,false);
 b.fail(Error('offline'));await b.get('#logout').onclick();
 assert.equal(b.local.get(key),oldValue);assert.match(b.get('#account-status').textContent,/로그아웃하지 못했어요/);
 b.fail(null);await b.get('#logout').onclick();
 assert.equal(b.local.has(key),false);
 other.events.get('storage')({key,oldValue,newValue:null});
 assert.equal(other.eval('mode'),'login');assert.equal(other.get('#change-password').hidden,true);
 assert.equal(browser({local:b.local}).eval('mode'),'login');
});

test('revoked session exposes login and never falls back to device-only storage',async()=>{
 const b=browser();await b.login();
 const expired=Error('다시 로그인');expired.status=401;b.fail(expired);await b.eval('refreshShared(true)');
 assert.equal(b.eval('mode'),'login');assert.equal(b.eval('sharedReady'),false);assert.equal(b.get('#login-form').hidden,false);
 assert.equal(b.local.has('somhouse-session-v1'),false);
 assert.equal(await b.eval("changeItem('shopping',{id:'blocked',title:'차단',quantity:'1'})"),false);
});

test('legacy originals migrate automatically once and are never overwritten',async()=>{
 const raw=JSON.stringify({records:[],schedule:[],shopping:[{id:'old',title:'기존 기록',quantity:'1'}]});
 const b=browser({raw});await b.login();await b.eval('refreshShared()');
 assert.equal(b.eval('data.shopping[0].id'),'old');assert.equal(b.calls.filter(x=>x.url.endsWith('/api/merge')).length,1);
 assert.equal(b.local.get('somhouse-v1'),raw);
});

test('automatic polling reflects additions, edits and deletion from the other phone',async()=>{
 const server=family(),a=browser({server}),b=browser({server});await a.login('family1');await b.login('family2');
 await a.eval("changeItem('shopping',{id:'a',title:'추가',quantity:'1'})");
 b.timers[0].callback();await b.settle();assert.equal(b.eval('data.shopping[0].title'),'추가');
 await a.eval("changeItem('shopping',{id:'a',title:'수정',quantity:'2'})");
 b.timers[0].callback();await b.settle();assert.equal(b.eval('data.shopping[0].title'),'수정');
 await a.eval("changeItem('shopping',{id:'a'},true)");
 b.timers[0].callback();await b.settle();assert.equal(b.eval('data.shopping.length'),0);
 assert.equal(b.timers[0].delay,2000);
});

test('polls preserve open editors and resume automatically after returning to the app',async()=>{
 const b=browser();await b.login();b.get('#dialog').open=true;const count=b.calls.length;
 b.timers[0].callback();await b.settle();assert.equal(b.calls.length,count);
 b.get('#dialog').open=false;b.events.get('visibilitychange')();await b.settle();assert.ok(b.calls.length>count);
});

test('a pending read cannot replace the result of a later save',async()=>{
 const b=browser();await b.login();let release;
 b.server.readGate=new Promise(resolve=>release=resolve);
 const read=b.eval('refreshShared()');await b.settle();
 const write=b.eval("changeItem('shopping',{id:'new',title:'새 기록',quantity:'1'})");
 release();await read;assert.equal(await write,true);assert.equal(b.eval('data.shopping[0].title'),'새 기록');
});

test('unchanged polls do not rebuild the search form and mid-read edits are preserved',async()=>{
 const b=browser();await b.login();b.get('#content').innerHTML='keep current form';await b.eval('refreshShared()');
 assert.equal(b.get('#content').innerHTML,'keep current form');
 let release;b.server.data.shopping=[{id:'x',title:'다른 폰 추가',quantity:'1'}];b.server.readGate=new Promise(resolve=>release=resolve);
 const read=b.eval('refreshShared()');await b.settle();b.context.document.activeElement={closest:()=>true};release();await read;
 assert.equal(b.get('#content').innerHTML,'keep current form');
 b.context.document.activeElement=null;await b.eval('refreshShared()');assert.notEqual(b.get('#content').innerHTML,'keep current form');
});
