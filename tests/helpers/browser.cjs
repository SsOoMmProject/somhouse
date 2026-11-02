const fs=require('node:fs');
const vm=require('node:vm');
const blank=()=>({records:[],schedule:[],shopping:[]});
const clone=value=>JSON.parse(JSON.stringify(value));
function family(){return {data:blank(),imported:new Set(),failure:null,readGate:null};}
function browser({raw=JSON.stringify(blank()),session=null,server=family(),fetcher=null}={}){
 const local=new Map([['somhouse-v1',raw]]),sessionData=new Map(session?[['somhouse-session-v1',JSON.stringify(session)]]:[]);
 const elements=new Map(),events=new Map(),calls=[],alerts=[],timers=[];
 let blockRead=false,blockWrite=false;
 const element=()=>({classList:{add(){},toggle(){}},setAttribute(){},removeAttribute(){},prepend(){},addEventListener(){},querySelector(){return element();},innerHTML:'',textContent:'',value:'',hidden:false,open:false,close(){this.open=false;},showModal(){this.open=true;}});
 const get=sel=>{if(!elements.has(sel))elements.set(sel,element());return elements.get(sel);};
 const context={console,URL,AbortController,setTimeout,clearTimeout,setInterval:(callback,delay)=>timers.push({callback,delay}),Date,location:{hash:'',hostname:'localhost'},
 localStorage:{getItem:k=>{if(blockRead&&k==='somhouse-v1')throw Error('blocked');return local.get(k)??null;},setItem:(k,v)=>{if(blockWrite)throw Error('full');local.set(k,v);},removeItem:k=>local.delete(k)},
 sessionStorage:{getItem:k=>sessionData.get(k)??null,setItem:(k,v)=>sessionData.set(k,v),removeItem:k=>sessionData.delete(k)},alert:s=>alerts.push(s),confirm:()=>true,
 document:{hidden:false,activeElement:null,querySelector:get,querySelectorAll:()=>[],addEventListener:(name,fn)=>events.set(name,fn),createElement:element},
 fetch:async(url,options)=>{
  calls.push({url,options});if(server.failure)throw server.failure;
  let result;
  if(url.endsWith('/api/login'))result={token:'test-token',username:JSON.parse(options.body).username};
  else if(url.endsWith('/api/merge')){
   const original=JSON.parse(options.body);
   for(const k of Object.keys(original))for(const item of original[k]){const key=k+':'+item.id;if(!server.imported.has(key)&&!server.data[k].some(x=>x.id===item.id))server.data[k].push(clone(item));server.imported.add(key);}
   result={data:clone(server.data)};
  }else if(options.method==='PUT'){
   const item=JSON.parse(options.body),kind=url.split('/').at(-2);
   server.data[kind]=server.data[kind].filter(x=>x.id!==item.id);server.data[kind].push(clone(item));result={data:clone(server.data)};
  }else if(options.method==='DELETE'){
   const parts=url.split('/'),kind=parts.at(-2),id=decodeURIComponent(parts.at(-1));server.data[kind]=server.data[kind].filter(x=>x.id!==id);result={data:clone(server.data)};
  }else result={data:clone(server.data)};
  if(url.endsWith('/api/data')&&server.readGate){const gate=server.readGate;server.readGate=null;await gate;}
  return {ok:true,json:async()=>result};
 }};
 if(fetcher)context.fetch=fetcher;
 context.window=context;context.addEventListener=(name,fn)=>events.set(name,fn);
 vm.createContext(context);
 for(const path of ['service.js','shared.js','app.js'])vm.runInContext(fs.readFileSync(require.resolve('../../'+path),'utf8'),context);
 return {eval:code=>vm.runInContext(code,context),local,sessionData,calls,alerts,get,server,events,timers,context,
  fail:error=>server.failure=error,blockRead:()=>blockRead=true,blockWrite:()=>blockWrite=true,settle:()=>new Promise(resolve=>setImmediate(resolve)),
  login:async(name='family1',password='password',base='http://127.0.0.1:8787')=>{await vm.runInContext(`shared.login(${JSON.stringify(base)},${JSON.stringify(name)},${JSON.stringify(password)})`,context);vm.runInContext("mode='shared'",context);await vm.runInContext('refreshShared(true)',context);}};
}
module.exports={browser,family,blank};
