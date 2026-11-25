const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const clone=value=>JSON.parse(JSON.stringify(value));
// Numéros fictifs : aucune donnée d'identité réelle dans les tests.
const FIRST='00123456789',SECOND='00987654321';
const monitor={id:'u-a',monitorId:'MON-A',role:'MONITOR',active:true};
const director={id:'u-director',role:'DIRECTOR',active:true};
const people=[{id:'MON-A',name:'Alice Exemple',active:true},{id:'STAGE-B',name:'Basile Exemple',active:true},{id:'OLD-C',name:'Ancienne Exemple',active:false}];
function harness(){
 const db={IDENTITY:[],AUDIT:[]},writes=[],logs=[];let sequence=0,fail='';
 const ctx=vm.createContext({Date,JSON,Number,console:{log:message=>logs.push(message)},
  pPeople_:()=>clone(people),pGet_:(table,id)=>clone((db[table]||[]).find(row=>row.id===id)||null),
  pNow_:()=> '2026-11-17T12:00:00.000Z',pId_:()=> 'audit-'+(++sequence),
  pHash_:value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'),
  pCommit_:(changes,actor,action)=>{
   if(fail==='before'){fail='';throw Error('commit refused');}
   for(const change of changes){assert.ok(['IDENTITY','AUDIT'].includes(change.table));const row=clone(change.record),index=db[change.table].findIndex(old=>old.id===row.id);if(index<0)db[change.table].push(row);else db[change.table][index]=row;}
   writes.push(clone(changes));db.AUDIT.push({id:'audit-'+(++sequence),actorId:actor.id,action,changes:changes.map(change=>({table:change.table,id:change.record.id,revision:change.record.revision||0}))});
   if(fail==='after'){fail='';throw Error('commit response lost');}
  }});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../apps-script/Identity.gs'),'utf8'),ctx);
 return {ctx,db,writes,logs,failCommit:value=>fail=value};
}
function submission(extra={}){return {niss:FIRST,revision:0,requestId:'identity-request-0001',...extra};}
function review(extra={}){return {monitorId:'MON-A',revision:1,decision:'APPROVE',reason:'',...extra};}
function noRaw(value){const text=JSON.stringify(value);assert.ok(!text.includes(FIRST)&&!text.includes(SECOND),'raw NISS leaked in projection');}

test('missing identity is a masked projection; active stage members have their own profile',()=>{
 const h=harness(),view=h.ctx.pGetIdentity_(monitor);
 assert.equal(view.status,'MISSING');assert.equal(view.revision,0);assert.equal(view.hasNiss,false);assert.equal(view.canSubmit,true);assert.ok(!('niss'in view));
 const stage={id:'u-b',monitorId:'STAGE-B',role:'MONITOR',active:true};
 assert.equal(h.ctx.pGetIdentity_(stage).monitorId,'STAGE-B');
 assert.equal(h.ctx.pSubmitIdentity_(stage,submission()).status,'PENDING');
 assert.equal(h.db.IDENTITY[0].id,'STAGE-B');
});
test('monitors and technical accounts cannot read or propose another person identity',()=>{
 const h=harness();
 for(const role of ['MONITOR','TECHNICAL'])for(const method of ['pGetIdentity_','pRevealIdentity_'])assert.throws(()=>h.ctx[method]({...monitor,role},{monitorId:'STAGE-B'}),/uniquement votre propre/);
 assert.throws(()=>h.ctx.pSubmitIdentity_(monitor,submission({monitorId:'STAGE-B'})),/uniquement votre propre/);
 for(const actor of [null,{...monitor,active:false},{...monitor,role:'ADMIN'}, {...monitor,id:''}])assert.throws(()=>h.ctx.pGetIdentity_(actor),/non autorisé/);
 assert.equal(h.writes.length,0);
});
test('staff can select a known person, but only DIRECTOR reviews including an administrative director account',()=>{
 const h=harness();h.ctx.pSubmitIdentity_(monitor,submission());
 for(const role of ['DIRECTOR','MANAGER','SECRETARY']){
  const actor={id:'staff-'+role,active:true,role};
  assert.equal(h.ctx.pGetIdentity_(actor,{monitorId:'MON-A'}).hasPending,true);
  assert.equal(h.ctx.pRevealIdentity_(actor,{monitorId:'MON-A'}).pendingNiss,FIRST);
 }
 for(const role of ['MANAGER','SECRETARY','MONITOR','TECHNICAL'])assert.throws(()=>h.ctx.pReviewIdentity_({...monitor,role},review()),/réservée à la direction/);
 const administrative={id:'account-atout-admin',email:'direction@example.test',role:'DIRECTOR',active:true};
 assert.equal(h.ctx.pReviewIdentity_(administrative,review()).status,'VERIFIED');
});
test('NISS validation accepts formatted strings and leading zero; it rejects numeric values and invented dates are not checked',()=>{
 const h=harness();h.ctx.pSubmitIdentity_(monitor,submission({niss:'00.12.34-567.89'}));assert.equal(h.db.IDENTITY[0].pending.niss,FIRST);
 assert.equal(h.ctx.pIdentityNiss_('99999999999'),'99999999999');
 for(const niss of [12345678901,null,{},'', '1234567890','123456789012','00x23456789','0'.repeat(33)]){const other=harness();assert.throws(()=>other.ctx.pSubmitIdentity_(monitor,submission({niss})),/11 chiffres/);assert.equal(other.writes.length,0);}
});
test('validated value appears only on reveal; pending value is not used by contracts',()=>{
 const h=harness(),pending=h.ctx.pSubmitIdentity_(monitor,submission());
 noRaw(pending);assert.equal(pending.pendingMaskedNiss,'•••••••6789');assert.equal(h.ctx.pIdentityApprovedNiss_('MON-A'),'');
 const verified=h.ctx.pReviewIdentity_(director,review());noRaw(verified);assert.equal(h.ctx.pIdentityApprovedNiss_('MON-A'),FIRST);
 assert.equal(h.ctx.pRevealIdentity_(monitor).niss,FIRST);noRaw(h.ctx.pGetIdentity_(monitor));
 h.ctx.pSubmitIdentity_(monitor,submission({niss:SECOND,revision:2,requestId:'identity-request-0002'}));
 assert.equal(h.ctx.pIdentityApprovedNiss_('MON-A'),FIRST);assert.equal(h.ctx.pRevealIdentity_(monitor).pendingNiss,SECOND);
});
test('reject requires a reason and preserves the validated NISS while discarding rejected plaintext',()=>{
 const h=harness();h.ctx.pSubmitIdentity_(monitor,submission());h.ctx.pReviewIdentity_(director,review());
 h.ctx.pSubmitIdentity_(monitor,submission({niss:SECOND,revision:2,requestId:'identity-request-0002'}));
 assert.throws(()=>h.ctx.pReviewIdentity_(director,review({revision:3,decision:'REJECT'})),/motif de refus/);
 const rejected=h.ctx.pReviewIdentity_(director,review({revision:3,decision:'REJECT',reason:'Une correction est nécessaire.'}));
 assert.equal(rejected.status,'REJECTED');assert.equal(rejected.hasNiss,true);assert.equal(rejected.hasPending,false);assert.equal(rejected.canSubmit,true);noRaw(rejected);
 assert.equal(h.db.IDENTITY[0].niss,FIRST);assert.equal(h.db.IDENTITY[0].pending,null);assert.ok(!JSON.stringify(h.db.IDENTITY[0]).includes(SECOND));
});
test('request replay is idempotent before and after review and a changed payload cannot reuse the same key',()=>{
 const h=harness(),request=submission();h.ctx.pSubmitIdentity_(monitor,request);const writes=h.writes.length;
 assert.equal(h.ctx.pSubmitIdentity_(monitor,request).revision,1);assert.equal(h.writes.length,writes);
 assert.throws(()=>h.ctx.pSubmitIdentity_(monitor,{...request,niss:SECOND}),/déjà été utilisé/);
 h.ctx.pReviewIdentity_(director,review());const after=h.writes.length;
 assert.equal(h.ctx.pSubmitIdentity_(monitor,request).status,'VERIFIED');assert.equal(h.writes.length,after);
 assert.equal(h.ctx.pReviewIdentity_(director,review()).status,'VERIFIED');assert.equal(h.writes.length,after);
 assert.throws(()=>h.ctx.pReviewIdentity_(director,review({decision:'REJECT',reason:'Autre décision'})),/a changé/);
});
test('stale revision, concurrent proposal and foreign fields cannot overwrite a pending request',()=>{
 const h=harness();h.ctx.pSubmitIdentity_(monitor,submission());const before=clone(h.db.IDENTITY);
 assert.throws(()=>h.ctx.pSubmitIdentity_(director,submission({monitorId:'MON-A',revision:0,niss:SECOND,requestId:'staff-request-0002'})),/a changé/);
 assert.throws(()=>h.ctx.pSubmitIdentity_(director,submission({monitorId:'MON-A',revision:1,niss:SECOND,requestId:'staff-request-0002'})),/attend déjà/);
 for(const revision of [-1,'1',1.2])assert.throws(()=>h.ctx.pSubmitIdentity_(monitor,submission({revision})),/Version/);
 for(const field of ['status','role','nissApproved','file','fileId','pending'])assert.throws(()=>h.ctx.pSubmitIdentity_(monitor,submission({[field]:'forged'})),/champ non autorisé/);
 assert.throws(()=>h.ctx.pReviewIdentity_(director,{...review(),niss:SECOND}),/champ non autorisé/);
 assert.deepEqual(h.db.IDENTITY,before);
});
test('unknown persons fail closed and inactive known persons can only be read',()=>{
 const h=harness();assert.throws(()=>h.ctx.pGetIdentity_(director,{monitorId:'MISSING'}),/absente ou en double/);
 const view=h.ctx.pGetIdentity_(director,{monitorId:'OLD-C'});assert.equal(view.canSubmit,false);
 assert.throws(()=>h.ctx.pSubmitIdentity_(director,submission({monitorId:'OLD-C'})),/inactive/);
});
test('uncertain storage response can be retried safely without duplicate requests or validations',()=>{
 const h=harness(),request=submission();h.failCommit('after');assert.throws(()=>h.ctx.pSubmitIdentity_(monitor,request),/response lost/);
 assert.equal(h.ctx.pSubmitIdentity_(monitor,request).revision,1);assert.equal(h.writes.length,1);
 h.failCommit('after');assert.throws(()=>h.ctx.pReviewIdentity_(director,review()),/response lost/);
 assert.equal(h.ctx.pReviewIdentity_(director,review()).revision,2);assert.equal(h.writes.length,2);
 const fail=harness();fail.failCommit('before');assert.throws(()=>fail.ctx.pSubmitIdentity_(monitor,request),/refused/);assert.equal(fail.db.IDENTITY.length,0);
});
test('reveals are audited only by actor/person identifiers; requests, rejections, logs and audit never include raw NISS',()=>{
 const h=harness();h.ctx.pSubmitIdentity_(monitor,submission());h.ctx.pRevealIdentity_(monitor);
 h.ctx.pReviewIdentity_(director,review({decision:'REJECT',reason:'À vérifier'}));
 assert.ok(h.db.AUDIT.some(row=>row.action==='CONSULTER_NISS'&&row.monitorId==='MON-A'&&row.actorId===monitor.id));
 noRaw(h.db.AUDIT);noRaw(h.logs);
 assert.ok(h.writes.flat().every(change=>change.table==='IDENTITY'||!JSON.stringify(change).includes(FIRST)));
 h.failCommit('before');assert.throws(()=>h.ctx.pRevealIdentity_(monitor),/refused/);
});
test('old approval retry never approves a more recent pending NISS',()=>{
 const h=harness();h.ctx.pSubmitIdentity_(monitor,submission());h.ctx.pReviewIdentity_(director,review());
 h.ctx.pSubmitIdentity_(monitor,submission({niss:SECOND,revision:2,requestId:'identity-request-0002'}));
 const result=h.ctx.pReviewIdentity_(director,review());assert.equal(result.status,'PENDING');assert.equal(result.revision,3);
 assert.equal(h.db.IDENTITY[0].niss,FIRST);assert.equal(h.db.IDENTITY[0].pending.niss,SECOND);
});
test('legacy migration proposes valid remembered NISS without approval or overwrite and exposes no plaintext',()=>{
 const h=harness(),result=h.ctx.pIdentityImportLegacy_(director,'MON-A',FIRST);
 assert.equal(result.imported,true);assert.equal(result.reason,'PENDING_VALIDATION');noRaw(result);
 assert.equal(h.db.IDENTITY[0].status,'PENDING');assert.equal(h.ctx.pIdentityApprovedNiss_('MON-A'),'');
 const before=clone(h.db.IDENTITY);
 assert.equal(h.ctx.pIdentityImportLegacy_(director,'MON-A',SECOND).reason,'ALREADY_PRESENT');assert.deepEqual(h.db.IDENTITY,before);
 assert.equal(h.ctx.pIdentityImportLegacy_(director,'MISSING',FIRST).reason,'UNKNOWN_PERSON');
 assert.equal(h.ctx.pIdentityImportLegacy_(director,'OLD-C',FIRST).reason,'INACTIVE_PERSON');
 assert.equal(h.ctx.pIdentityImportLegacy_(director,'STAGE-B','invalid').reason,'INVALID_VALUE');
 assert.throws(()=>h.ctx.pIdentityImportLegacy_(monitor,'MON-A',FIRST),/réservée/);noRaw(h.db.AUDIT);
});
