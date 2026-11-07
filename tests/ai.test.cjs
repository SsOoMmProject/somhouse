const {test}=require('node:test');
const assert=require('node:assert/strict');
const {browser,blank}=require('./helpers/browser.cjs');

test('AI form preserves drafts during polling and errors, then displays a plain text answer',async()=>{
 const calls=[];
 let rejectAI=true;
 const b=browser({
  session:{base:'http://127.0.0.1:8787',token:'existing',username:'family1'},
  fetcher:async(url,options)=>{
   calls.push({url,options});
   let result={data:blank()},ok=true;
   if(url.endsWith('/api/ai')){
    if(options.method==='GET')result={enabled:true,recordSummaries:true};
    else if(rejectAI){result={error:'Gemini failed'};ok=false;}
    else result={answer:'<script>plain text</script>',truncated:false};
   }
   return {ok,status:ok?200:502,json:async()=>result};
  },
 });
 await b.settle();
 b.context.location.hash='#ai';b.events.get('hashchange')();await b.settle();
 assert.equal(b.get('#ai-panel').hidden,false);
 assert.equal(b.get('#ai-fields').disabled,false);
 const form=b.get('#ai-form');
 form.values={question:'수유 요약',scope:'feeding'};
 b.get('#ai-question').value='수유 요약';
 await b.eval('refreshShared(true)');
 assert.equal(b.get('#ai-question').value,'수유 요약');
 await form.onsubmit({preventDefault(){},target:form});
 assert.equal(b.get('#ai-question').value,'수유 요약');
 assert.equal(b.get('#ai-status').textContent,'Gemini failed');
 rejectAI=false;
 await form.onsubmit({preventDefault(){},target:form});
 assert.equal(b.get('#ai-answer').textContent,'<script>plain text</script>');
 assert.equal(b.get('#ai-answer').innerHTML,'');
 assert.equal(b.get('#ai-result').hidden,false);
 assert.equal(b.get('#ai-question').value,'');
 const request=calls.filter(x=>x.url.endsWith('/api/ai')&&x.options.method==='POST').at(-1);
 assert.deepEqual(JSON.parse(request.options.body),{question:'수유 요약',scope:'feeding'});
 await b.get('#logout').onclick();
 assert.equal(b.get('#ai-panel').hidden,true);
 assert.equal(b.get('#ai-answer').textContent,'');
});

test('an AI response arriving after logout cannot reappear in the next login',async()=>{
 let finishAI;
 const b=browser({
  session:{base:'http://127.0.0.1:8787',token:'existing',username:'family1'},
  fetcher:async(url,options)=>{
   let result={data:blank()};
   if(url.endsWith('/api/ai')){
    if(options.method==='GET')result={enabled:true,recordSummaries:false};
    else result=await new Promise(resolve=>{finishAI=()=>resolve({answer:'old answer'});});
   }
   return {ok:true,json:async()=>result};
  },
 });
 await b.settle();
 b.context.location.hash='#ai';b.events.get('hashchange')();await b.settle();
 const form=b.get('#ai-form');
 form.values={question:'안녕',scope:'feeding'};
 const pending=form.onsubmit({preventDefault(){},target:form});
 await b.settle();
 assert.equal(b.get('#ai-fields').disabled,true);
 await b.get('#logout').onclick();
 finishAI();await pending;
 assert.equal(b.get('#ai-answer').textContent,'');
 assert.equal(b.eval('mode'),'login');
});
