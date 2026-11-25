const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const clone=x=>JSON.parse(JSON.stringify(x));
const user={id:'account-a',uid:'firebase-a',email:'alice@example.test',name:'Alice Martin',monitorId:'MON-A',role:'MONITOR',active:true,revision:1};
const headers=['MoniteurID','Role','Nom','Prenom','Email','Telephone','Adresse','Photo','PrixHeure'];
function harness(options={}) {
 const db={USERS:clone(options.users||[user])},source=[headers.slice(),['MON-A','MONITEUR','','','alice@example.test','+32 123','Ancienne adresse','private-photo',22],['MON-B','MONITEUR','','','bob@example.test','','','photo-b',30]],commits=[],writes=[];
 let failedReads=0,failedWrites=0,commitFault='',writeResponseLost=false;
 const ctx=vm.createContext({console,Date,JSON,encodeURIComponent,
  pProperties_:()=>({getProperty:k=>k==='ADMIN_BOOK_ID'?'private-admin':null}),
  ScriptApp:{getOAuthToken:()=> 'server-only-token'},
  pRows_:table=>clone(db[table]||[]),pGet_:(table,id)=>clone((db[table]||[]).find(u=>u.id===id)||null),
  pCommit_:(changes,actor,action)=>{commits.push({changes:clone(changes),actor,action});if(commitFault==='before'){commitFault='';throw Error('timeout before commit');}for(const change of changes){const index=db[change.table].findIndex(x=>x.id===change.record.id);if(index<0)db[change.table].push(clone(change.record));else db[change.table][index]=clone(change.record);}if(commitFault==='after'){commitFault='';throw Error('lost commit response');}},
  pHash_:x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex'),pNow_:()=>new Date().toISOString(),
  pPeople_:()=>[{id:'MON-A',name:'Alice Martin',active:true},{id:'MON-B',name:'Bob',active:true}],
  pPeopleRows_:()=>[{MoniteurID:'MON-A',Prenom:'Alice',Nom:'Martin',Actif:true}],
  UrlFetchApp:{fetch:(url,options)=>{assert.match(url,/spreadsheets\/private-admin/);let data;if(options.method==='post'){if(failedWrites){failedWrites--;throw Error('offline');}const body=JSON.parse(options.payload);writes.push(clone(body));for(const r of body.requests){const update=r.updateCells;source[update.range.startRowIndex][update.range.startColumnIndex]=update.rows[0].values[0].userEnteredValue.stringValue;}if(writeResponseLost){writeResponseLost=false;throw Error('write response lost');}data={};}else if(url.includes('/values/')){if(failedReads){failedReads--;throw Error('offline');}data={values:clone(source)};}else data={sheets:[{properties:{sheetId:91,title:'EQUIPE_EXTRA',gridProperties:{rowCount:1000,columnCount:26}}}]};return {getResponseCode:()=>200,getContentText:()=>JSON.stringify(data)};}}
 });
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../apps-script/Auth.gs'),'utf8'),ctx);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../apps-script/Profile.gs'),'utf8'),ctx);
 return {ctx,db,source,writes,commits,actor:()=>ctx.pPublicUser_(db.USERS[0]),failWrites:()=>failedWrites++,failReads:()=>failedReads++,commitFault:x=>commitFault=x,loseWriteResponse:()=>writeResponseLost=true};
}
function changes(h,extra={}) {const view=h.ctx.pGetProfile_(h.actor());return {revision:view.revision,sourceRevision:view.sourceRevision,phone:'+32 456',address:'Nouvelle rue 1\n5000 Namur',requestId:'profile-operation-001',...extra};}
function requestEmail(h,email='newalice@example.test',extra={}) {return h.ctx.pRequestProfileEmail_(h.actor(),{revision:h.db.USERS[0].revision,email,requestId:'email-operation-001',...extra});}

test('profile reads own private coordinates and names without exposing internal identifiers',()=>{
 const h=harness(),view=h.ctx.pGetProfile_(h.actor());assert.equal(view.firstName,'Alice');assert.equal(view.phone,'+32 123');assert.equal(view.email,user.email);assert.equal(view.editable,true);assert.ok(!('uid' in view));assert.ok(!('Photo' in view));
 assert.throws(()=>h.ctx.pGetProfile_({...h.actor(),id:'another'}),/pas actif/);
 h.db.USERS[0].active=false;assert.throws(()=>h.ctx.pGetProfile_(h.actor()),/pas actif/);
});
test('save touches only private telephone/address cells and supports blank optional fields',()=>{
 const h=harness(),before=clone(h.source),result=h.ctx.pSaveProfile_(h.actor(),changes(h,{address:'',phone:''}));
 assert.equal(result.syncStatus,'SYNCED');assert.equal(result.phone,'');assert.equal(result.address,'');
 assert.equal(h.source[1][4],before[1][4]);assert.equal(h.source[1][7],before[1][7]);assert.equal(h.source[1][8],before[1][8]);assert.deepEqual(h.source[2],before[2]);
 const cols=h.writes.flatMap(w=>w.requests.map(r=>r.updateCells.range.startColumnIndex));assert.deepEqual(cols,[5,6]);
});
test('browser cannot assign another monitor or write name, roles, pictures, tariffs, NISS or arbitrary fields',()=>{
 for(const field of ['monitorId','firstName','lastName','role','Photo','PrixHeure','email','niss','NISS']){const h=harness();assert.throws(()=>h.ctx.pSaveProfile_(h.actor(),changes(h,{[field]:'forged'})),/non autorisé/);assert.equal(h.writes.length,0);}
});
test('stale portal revision or private source revision prevents any write',()=>{
 const h=harness(),p=changes(h);h.db.USERS[0].revision++;
 assert.throws(()=>h.ctx.pSaveProfile_(h.actor(),p),/fiche a changé/);p.revision++;
 h.source[1][5]='Changed by secretary';assert.throws(()=>h.ctx.pSaveProfile_(h.actor(),p),/administratives ont changé/);assert.equal(h.writes.length,0);
});
test('save retry is idempotent and does not accept another payload under same request ID',()=>{
 const h=harness(),p=changes(h);h.ctx.pSaveProfile_(h.actor(),p);const count=h.writes.length;
 h.ctx.pSaveProfile_(h.actor(),p);assert.equal(h.writes.length,count);
 assert.throws(()=>h.ctx.pSaveProfile_(h.actor(),{...p,address:'Different'}),/déjà été utilisé/);
});
test('durable intent retries failed private write without losing user changes',()=>{
 const h=harness(),p=changes(h);h.failWrites();const first=h.ctx.pSaveProfile_(h.actor(),p);
 assert.equal(first.syncStatus,'PENDING');assert.equal(h.db.USERS[0].profileSync.after.Adresse,p.address);assert.equal(h.source[1][6],'Ancienne adresse');
 const next=h.ctx.pGetProfile_(h.actor());assert.equal(next.syncStatus,'SYNCED');assert.equal(h.source[1][6],p.address);
});
test('uncertain write response is reconciled without duplicate writes',()=>{
 const h=harness(),p=changes(h);h.loseWriteResponse();h.ctx.pSaveProfile_(h.actor(),p);
 assert.equal(h.db.USERS[0].profileSync.status,'PENDING');assert.equal(h.writes.length,1);
 assert.equal(h.ctx.pGetProfile_(h.actor()).syncStatus,'SYNCED');assert.equal(h.writes.length,1);
});
test('a third-party modification during retry creates a conflict instead of overwriting it',()=>{
 const h=harness(),p=changes(h);h.failWrites();h.ctx.pSaveProfile_(h.actor(),p);h.source[1][6]='Correction secrétaire';
 const result=h.ctx.pGetProfile_(h.actor());assert.equal(result.syncStatus,'CONFLICT');assert.equal(result.address,'Correction secrétaire');assert.equal(h.writes.length,0);
});
test('unverified browser email never changes the account or source',()=>{
 const h=harness(),result=requestEmail(h);assert.equal(result.pendingEmail.email,'newalice@example.test');assert.equal(h.db.USERS[0].email,user.email);assert.equal(h.source[1][4],user.email);
 assert.throws(()=>h.ctx.pCompleteProfileEmail_({uid:'attacker',email:'newalice@example.test'},{}),/pas actif/);
 assert.throws(()=>h.ctx.pCompleteProfileEmail_({uid:user.uid,email:'unrequested@example.test'},{}),/pas été demandé/);
});
test('verified completion binds the same UID, updates account before retryable private sync and is idempotent',()=>{
 const h=harness();requestEmail(h);h.failWrites();const identity={uid:user.uid,email:'newalice@example.test'},result=h.ctx.pCompleteProfileEmail_(identity,{email:'attacker@example.test',monitorId:'MON-B'});
 assert.equal(result.completed,true);assert.equal(result.syncStatus,'PENDING');assert.equal(h.db.USERS[0].uid,user.uid);assert.equal(h.db.USERS[0].email,identity.email);assert.equal(h.db.USERS[0].monitorId,user.monitorId);
 const retry=h.ctx.pCompleteProfileEmail_(identity,{});assert.equal(retry.completed,false);assert.equal(retry.syncStatus,'SYNCED');assert.equal(h.source[1][4],identity.email);
});
test('same verified UID can recover a completed Firebase change after reminder expiry, but revoked account cannot',()=>{
 const h=harness();requestEmail(h);h.db.USERS[0].pendingEmail.expiresAt='2000-01-01T00:00:00Z';
 assert.equal(h.ctx.pCompleteProfileEmail_({uid:user.uid,email:'newalice@example.test'},{}).completed,true);
 const blocked=harness();requestEmail(blocked);blocked.db.USERS[0].active=false;
 assert.throws(()=>blocked.ctx.pCompleteProfileEmail_({uid:user.uid,email:'newalice@example.test'},{}),/pas actif/);
});
test('email completion does not discard a pending address edit',()=>{
 const h=harness();requestEmail(h);const p=changes(h);h.failWrites();h.ctx.pSaveProfile_(h.actor(),p);h.failWrites();
 h.ctx.pCompleteProfileEmail_({uid:user.uid,email:'newalice@example.test'},{});
 const operation=h.db.USERS[0].profileSync;assert.equal(operation.after.Adresse,p.address);assert.equal(operation.after.Email,'newalice@example.test');
 h.ctx.pGetProfile_(h.actor());assert.equal(h.source[1][6],p.address);assert.equal(h.source[1][4],'newalice@example.test');
});
test('email uniqueness includes active, deleted and reserved accounts, plus private monitor records',()=>{
 for(const extra of [{id:'b',email:'newalice@example.test',deleted:true},{id:'b',email:'bob@example.test',pendingEmail:{email:'newalice@example.test'}}]){const h=harness({users:[user,extra]});assert.throws(()=>requestEmail(h),/déjà utilisée ou réservée/);}
 const h=harness();assert.throws(()=>requestEmail(h,'bob@example.test'),/autre fiche/);
});
test('verified completion does not overwrite a conflicting private email edited by secretary',()=>{
 const h=harness();requestEmail(h);h.source[1][4]='secretary-new@example.test';
 const result=h.ctx.pCompleteProfileEmail_({uid:user.uid,email:'newalice@example.test'},{});assert.equal(result.syncStatus,'CONFLICT');assert.equal(h.source[1][4],'secretary-new@example.test');assert.equal(h.db.USERS[0].email,'newalice@example.test');
});
test('completion is safe no-op for an activated administrative account without monitor record',()=>{
 const h=harness({users:[{...user,monitorId:'',role:'DIRECTOR'}]});assert.equal(h.ctx.pCompleteProfileEmail_({uid:user.uid,email:user.email},{}).completed,false);assert.equal(h.ctx.pGetProfile_(h.actor()).editable,false);
});


test('an email conflict cannot be erased by a telephone edit and is resolved only after private source reconciliation',()=>{
 const h=harness();requestEmail(h);h.source[1][4]='secretary-new@example.test';h.ctx.pCompleteProfileEmail_({uid:user.uid,email:'newalice@example.test'},{});
 assert.throws(()=>h.ctx.pSaveProfile_(h.actor(),changes(h)),/autre adresse email/);
 assert.equal(h.db.USERS[0].profileSync.status,'CONFLICT');
 h.source[1][4]='newalice@example.test';const result=h.ctx.pGetProfile_(h.actor());assert.equal(result.syncStatus,'SYNCED');
});

test('lost portal commit response retains a retriable intent, while a rejected commit writes no private cells',()=>{
 const h=harness(),p=changes(h);h.commitFault('after');assert.throws(()=>h.ctx.pSaveProfile_(h.actor(),p),/lost commit response/);
 assert.equal(h.writes.length,0);assert.equal(h.db.USERS[0].profileSync.status,'PENDING');
 assert.equal(h.ctx.pSaveProfile_(h.actor(),p).syncStatus,'SYNCED');assert.equal(h.writes.length,1);
 const rejected=harness(),request=changes(rejected);rejected.commitFault('before');assert.throws(()=>rejected.ctx.pSaveProfile_(rejected.actor(),request),/before commit/);assert.equal(rejected.writes.length,0);assert.ok(!rejected.db.USERS[0].profileSync);
});


test('activation queues verified email to empty private record without blocking on source availability or touching TV',()=>{
 const secret='activation-token-'.repeat(4),h=harness({users:[{...user,uid:'',inviteHash:crypto.createHash('sha256').update(JSON.stringify(secret)).digest('hex'),inviteExpiresAt:new Date(Date.now()+60000).toISOString()}]});
 h.source[1][4]='';h.ctx.pActivate_({uid:user.uid,email:user.email},{invitationToken:secret});
 assert.equal(h.db.USERS[0].profileSync.status,'PENDING');assert.equal(h.writes.length,0);
 h.failWrites();assert.equal(h.ctx.pCompleteProfileEmail_({uid:user.uid,email:user.email},{}).syncStatus,'PENDING');
 assert.equal(h.ctx.pCompleteProfileEmail_({uid:user.uid,email:user.email},{}).syncStatus,'SYNCED');assert.equal(h.source[1][4],user.email);
 assert.deepEqual(h.writes.flatMap(w=>w.requests.map(r=>r.updateCells.range.startColumnIndex)),[4]);
});
test('initial activation preserves a pre-existing different private email as visible conflict',()=>{
 const secret='activation-token-'.repeat(4),h=harness({users:[{...user,uid:'',inviteHash:crypto.createHash('sha256').update(JSON.stringify(secret)).digest('hex'),inviteExpiresAt:new Date(Date.now()+60000).toISOString()}]});
 h.source[1][4]='other-record@example.test';h.ctx.pActivate_({uid:user.uid,email:user.email},{invitationToken:secret});
 assert.equal(h.ctx.pCompleteProfileEmail_({uid:user.uid,email:user.email},{}).syncStatus,'CONFLICT');assert.equal(h.source[1][4],'other-record@example.test');
});
test('active stage-only people can edit their coordinates without requiring the pool roster',()=>{
 const h=harness();
 h.ctx.pPeople_=()=>[{id:'MON-A',name:'Alice Stage',active:true,sectors:['STAGE']}];
 h.ctx.pPeopleRows_=()=>[{MoniteurID:'MON-A',Prenom:'Alice',Nom:'Stage',Actif:true,Role:'MONITEUR_STAGE'}];
 h.ctx.pTeam_=()=>{throw Error('Pool roster must not be consulted');};
 h.ctx.pPoolRows_=h.ctx.pTeam_;
 assert.equal(h.ctx.pGetProfile_(h.actor()).lastName,'Stage');
 assert.equal(h.ctx.pSaveProfile_(h.actor(),changes(h)).syncStatus,'SYNCED');
 h.ctx.pPeople_=()=>[{id:'MON-A',name:'Alice Stage',active:false}];
 assert.throws(()=>h.ctx.pGetProfile_(h.actor()),/personne active/);
});
