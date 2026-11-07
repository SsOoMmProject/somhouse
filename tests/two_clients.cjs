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

 const reopened=browser({local:a.local,fetcher:fetch});
 await waitFor(()=>reopened.eval('sharedReady'));
 reopened.get('#change-password').onclick();
 const form=reopened.get('#password-form'),submit={preventDefault(){}};
 const newPassword='easier family passphrase';
 form.values={currentPassword:'test-password-1',newPassword,confirmPassword:'different'};
 await form.onsubmit(submit);
 assert.match(reopened.get('#password-status').textContent,/서로 달라요/);
 form.values.confirmPassword=newPassword;
 await form.onsubmit(submit);
 assert.equal(reopened.get('#password-dialog').open,false);
 assert.match(reopened.get('#account-status').textContent,/로그인은 유지돼요/);
 await reopened.eval('refreshShared(true)');
 assert.equal(reopened.eval('sharedReady'),true);
 await reopened.get('#logout').onclick();
 assert.equal(browser({local:a.local,fetcher:fetch}).eval('mode'),'login');
 await a.get('#logout').onclick();await b.get('#logout').onclick();
 assert.equal(a.eval('mode'),'login');assert.equal(b.eval('mode'),'login');
 console.log('Frontend + real HTTP API: automatic record sync, persistent login, password change and logout.');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
