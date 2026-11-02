// Use the actual frontend scripts and actual temporary HTTP API, without a UI browser.
const assert=require('node:assert/strict');
const {browser}=require('./helpers/browser.cjs');
const base=process.argv[2];
async function waitFor(check){
 const limit=Date.now()+5000;
 while(!check()){if(Date.now()>limit)throw Error('Automatic update did not arrive');await new Promise(resolve=>setTimeout(resolve,20));}
}
(async()=>{
 const a=browser({fetcher:fetch}),b=browser({fetcher:fetch});
 await a.login('family1','test-password-1',base);await b.login('family2','test-password-2',base);
 assert.equal(a.eval('sharedReady'),true);assert.equal(b.eval('sharedReady'),true);
 assert.equal(await a.eval("changeItem('shopping',{id:'frontend',title:'자동 추가',quantity:'1'})"),true);
 b.timers[0].callback();await waitFor(()=>b.eval("data.shopping.some(x=>x.id==='frontend'&&x.title==='자동 추가')"));
 assert.equal(await a.eval("changeItem('shopping',{id:'frontend',title:'자동 수정',quantity:'2'})"),true);
 b.timers[0].callback();await waitFor(()=>b.eval("data.shopping.some(x=>x.id==='frontend'&&x.title==='자동 수정')"));
 assert.equal(await a.eval("changeItem('shopping',{id:'frontend'},true)"),true);
 b.timers[0].callback();await waitFor(()=>b.eval("!data.shopping.some(x=>x.id==='frontend')"));
 await a.get('#logout').onclick();await b.get('#logout').onclick();
 assert.equal(a.eval('mode'),'login');assert.equal(b.eval('mode'),'login');
 console.log('Two frontend sessions + real HTTP API: add, edit, delete automatically synchronized.');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
