const {test}=require('node:test');
const assert=require('node:assert/strict');
const {browser}=require('./helpers/browser.cjs');
test('corrupt legacy source is preserved while shared records remain usable',async()=>{
 const b=browser({raw:'{broken'});await b.login();
 assert.equal(b.local.get('somhouse-v1'),'{broken');assert.equal(b.eval('sharedReady'),true);
 assert.equal(b.calls.filter(x=>x.url.endsWith('/api/merge')).length,0);
 assert.ok(b.get('#connection-status').textContent.includes('원본은 보존'));
});
test('blocked legacy reads never cause a destructive replacement',async()=>{
 const raw=JSON.stringify({records:[],schedule:[],shopping:[{id:'original',title:'원본',quantity:'1'}]});
 const b=browser({raw});b.blockRead();await b.login();
 assert.equal(b.local.get('somhouse-v1'),raw);assert.equal(b.eval('sharedReady'),true);
 assert.equal(b.calls.filter(x=>x.url.endsWith('/api/merge')).length,0);
});
test('shared mutations work even when local storage writes are unavailable',async()=>{
 const b=browser();b.blockWrite();const original=b.local.get('somhouse-v1');await b.login();
 assert.equal(await b.eval("changeItem('shopping',{id:'server',title:'서버 저장',quantity:'1'})"),true);
 assert.equal(b.local.get('somhouse-v1'),original);assert.equal(b.eval('data.shopping[0].id'),'server');
});
