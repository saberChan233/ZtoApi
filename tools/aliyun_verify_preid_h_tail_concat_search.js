#!/usr/bin/env node
const { solveCaptcha } = require('./browserless_aliyun_captcha_solver');

function b64buf(s){ try{return Buffer.from(String(s||''),'base64')}catch{return Buffer.alloc(0)} }
function sharedPrefix(a,b){ const n=Math.min(a.length,b.length); let i=0; while(i<n && a[i]===b[i]) i++; return i; }

(async()=>{
  const out=await solveCaptcha({files:['/tmp/feilin.js','/tmp/aliyun-pe.js','/tmp/AliyunCaptcha.js'],loaderPath:'/tmp/AliyunCaptcha.js'});
  const join=(out.verifyGCallsiteLogs||[]).find(x=>x.stage==='join');
  const H=join?.namedParts?.H||'';
  const tail=b64buf(H).subarray(272);
  const rows=(out.feilinRsLogs||[]).map((x,i)=>{
    const b64=x.outputDefaultString||x.outputWordArrayBase64||'';
    const buf=b64buf(b64);
    return {i,arg0:x.arg0,arg1Len:x.arg1Length,len:buf.length,b64,buf,arg1Preview:(x.arg1||'').slice(0,160)};
  }).filter(x=>x.len);
  const unique=[];
  const seen=new Set();
  for(const r of rows){ const k=`${r.arg0}|${r.arg1Len}|${r.b64}`; if(seen.has(k)) continue; seen.add(k); unique.push(r); }
  const results=[];
  const N=unique.length;
  for(let a=0;a<N;a++){
    const ua=unique[a];
    const c1=ua.buf;
    results.push({combo:[ua.i],lens:[ua.len],sum:c1.length,prefix:sharedPrefix(c1,tail)});
    for(let b=0;b<N;b++){
      const ub=unique[b];
      const c2=Buffer.concat([ua.buf,ub.buf]);
      results.push({combo:[ua.i,ub.i],lens:[ua.len,ub.len],sum:c2.length,prefix:sharedPrefix(c2,tail)});
      for(let c=0;c<N;c++){
        const uc=unique[c];
        const sum=ua.len+ub.len+uc.len;
        if(sum>320) continue;
        const c3=Buffer.concat([ua.buf,ub.buf,uc.buf]);
        results.push({combo:[ua.i,ub.i,uc.i],lens:[ua.len,ub.len,uc.len],sum:c3.length,prefix:sharedPrefix(c3,tail)});
      }
    }
  }
  results.sort((x,y)=> y.prefix-x.prefix || Math.abs(272-x.sum)-Math.abs(272-y.sum));
  console.log(JSON.stringify({
    tailBytes: tail.length,
    unique: unique.map(x=>({i:x.i,arg0:x.arg0,arg1Len:x.arg1Len,len:x.len,arg1Preview:x.arg1Preview})),
    best: results.slice(0,30)
  }, null, 2));
})().catch(err=>{console.error(String(err&&err.stack||err));process.exit(1)})
