const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {serverURL}=require('../shared.js');

test('API URL allows HTTPS and loopback only, with no credentials or path',()=>{
 assert.equal(serverURL('https://family.example/'),'https://family.example');
 assert.equal(serverURL('http://127.0.0.1:8787'),'http://127.0.0.1:8787');
 for(const url of ['http://family.example','https://user:pass@family.example','https://family.example/api','https://family.example?token=x','javascript:alert(1)'])assert.throws(()=>serverURL(url));
});

function browser({raw=JSON.stringify({records:[],schedule:[],shopping:[]}),session=null}={}){
 const local=new Map([['somhouse-v1',raw]]),sessionData=new Map(session?[['somhouse-session-v1',JSON.stringify(session)]]:[]);
 const elements=new Map();const events=new Map();const calls=[];const alerts=[];
 const element=()=>({classList:{add(){},toggle(){}},setAttribute(){},removeAttribute(){},prepend(){},addEventListener(){},querySelector(){return element();},innerHTML:'',textContent:'',value:'',hidden:false,open:false,close(){this.open=false;}});
 const get=sel=>{if(!elements.has(sel))elements.set(sel,element());return elements.get(sel);};
 const storage=map=>({getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)});
 let failure=null;let shared={records:[],schedule:[],shopping:[]};
 const context={console,URL,AbortController,setTimeout,clearTimeout,setInterval(){},Date,Blob,location:{hash:'',hostname:'localhost'},localStorage:storage(local),sessionStorage:storage(sessionData),alert:s=>alerts.push(s),confirm:()=>true,
 document:{hidden:false,querySelector:get,querySelectorAll:()=>[],addEventListener:(name,fn)=>events.set(name,fn),createElement:element},
 fetch:async(url,options)=>{calls.push({url,options});if(failure)throw failure;let result={data:shared};if(options.method==='PUT'){const item=JSON.parse(options.body);shared={...shared,shopping:[item]};result={data:shared};}if(url.endsWith('/api/login'))result={token:'test-token',username:'family1'};return {ok:true,json:async()=>result};}};
 context.window=context;context.addEventListener=()=>{};
 vm.createContext(context);
 for(const path of ['service.js','shared.js','app.js'])vm.runInContext(fs.readFileSync(require.resolve('../'+path),'utf8'),context);
 return {eval:code=>vm.runInContext(code,context),local,sessionData,calls,alerts,get,fail:error=>failure=error,events,settle:()=>new Promise(resolve=>setImmediate(resolve))};
}

test('shared save preserves device originals and failure preserves entered data',async()=>{
 const original=JSON.stringify({records:[],schedule:[],shopping:[{id:'device',title:'원본',quantity:'1'}]});
 const b=browser({raw:original});
 await b.eval("shared.login('http://127.0.0.1:8787','family1','password')");
 b.eval("mode='shared';sharedReady=true;data=empty()");
 assert.equal(await b.eval("changeItem('shopping',{id:'shared',title:'공유',quantity:'1'})"),true);
 assert.equal(b.local.get('somhouse-v1'),original);
 assert.equal(b.eval('data.shopping[0].title'),'공유');
 b.fail(Error('offline'));
 assert.equal(await b.eval("changeItem('shopping',{id:'shared',title:'실패',quantity:'1'})"),false);
 assert.equal(b.eval('data.shopping[0].title'),'공유');
 assert.equal(b.local.get('somhouse-v1'),original);
 const call=b.calls.find(x=>x.options.method==='PUT');
 assert.equal(call.options.headers.Authorization,'Bearer test-token');
 assert.equal(call.options.credentials,'omit');
 assert.ok(!b.local.has('somhouse-session-v1'));
 assert.ok(b.sessionData.has('somhouse-session-v1'));
});

test('saved session restores shared data without replacing local originals',async()=>{
 const b=browser({session:{base:'http://127.0.0.1:8787',token:'existing',username:'family2'}});
 const original=b.local.get('somhouse-v1');
 await b.settle();
 assert.equal(b.eval('mode'),'shared');assert.equal(b.eval('sharedReady'),true);
 assert.equal(b.local.get('somhouse-v1'),original);
 assert.equal(b.calls[0].options.headers.Authorization,'Bearer existing');
});

test('expired session exposes login and prevents accidental device fallback',async()=>{
 const b=browser();await b.eval("shared.login('http://127.0.0.1:8787','family1','password')");
 b.eval("mode='shared';sharedReady=true");
 const expired=Error('다시 로그인');expired.status=401;b.fail(expired);
 await b.eval('refreshShared(true)');
 assert.equal(b.eval('mode'),'shared');assert.equal(b.eval('sharedReady'),false);
 assert.equal(b.get('#login-form').hidden,false);
 assert.equal(b.sessionData.has('somhouse-session-v1'),false);
 assert.equal(await b.eval("changeItem('shopping',{id:'blocked',title:'차단',quantity:'1'})"),false);
});

test('shared records with no device originals do not offer an unnecessary migration',async()=>{
 const b=browser();await b.eval("shared.login('http://127.0.0.1:8787','family1','password')");
 b.eval("mode='shared';sharedReady=true;connectionView()");
 await b.eval("changeItem('shopping',{id:'shared',title:'공유',quantity:'1'})");
 assert.equal(b.get('#migrate-local').hidden,true);
 assert.equal(b.get('#export-device').hidden,true);
 assert.ok(b.get('#migration-help').textContent.includes('이미 공유 저장'));
 assert.equal(b.eval('data.shopping.length'),1);
 assert.equal(JSON.parse(b.local.get('somhouse-v1')).shopping.length,0);
});

test('existing device originals remain available for explicit migration',()=>{
 const raw=JSON.stringify({records:[],schedule:[],shopping:[{id:'device',title:'기존 기록',quantity:'1'}]});
 const b=browser({raw});b.eval("mode='shared';sharedReady=true;connectionView()");
 assert.equal(b.get('#migrate-local').hidden,false);
 assert.ok(b.get('#migrate-local').textContent.includes('원본 1개'));
 assert.equal(b.local.get('somhouse-v1'),raw);
});
