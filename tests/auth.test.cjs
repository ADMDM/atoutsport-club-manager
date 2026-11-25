const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const code = fs.readFileSync(path.join(__dirname, '../apps-script/Auth.gs'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '../apps-script/Main.gs'), 'utf8');
const clone = v => JSON.parse(JSON.stringify(v));
function harness(options={}) {
 const props={FIREBASE_API_KEY:'public-web-key',FIREBASE_PROJECT_ID:'atoutsport-test',FIREBASE_AUTH_DOMAIN:'atoutsport-test.firebaseapp.com',FIREBASE_APP_ID:'test-app',PORTAL_BOOK_ID:'private-book',APP_URL:'https://script.google.com/macros/s/TEST_DEPLOYMENT/exec',...options.props};
 const db={USERS:clone(options.users||[]),OUTBOX:[]},requests=[],commits=[];
 const identity=options.identity||{localId:'uid-alice',email:'alice@example.test',emailVerified:true,validSince:'0'};
 const ctx=vm.createContext({console,Date,
  pProperties_:()=>({getProperty:key=>props[key]||null}),
  Utilities:{base64DecodeWebSafe:s=>Buffer.from(s,'base64url'),newBlob:b=>({getDataAsString:()=>Buffer.from(b).toString('utf8')})},
  UrlFetchApp:{fetch:(url,request)=>{requests.push({url,request});return {getResponseCode:()=>options.status||200,getContentText:()=>JSON.stringify({users:[identity]})};}},
  pRows_:name=>clone(db[name]||[]),pGet_:(name,id)=>clone((db[name]||[]).find(r=>r.id===id)||null),
  pCommit_:(changes,actor,action)=>{commits.push({changes:clone(changes),actor,action});for(const c of changes){db[c.table]??=[];const at=db[c.table].findIndex(x=>x.id===c.record.id);if(at<0)db[c.table].push(clone(c.record));else db[c.table][at]=clone(c.record);}},
  pHash_:v=>crypto.createHash('sha256').update(String(v)).digest('base64url'),
  pId_:()=>crypto.randomUUID(),pNow_:()=>new Date().toISOString(),pToday_:()=> '2026-11-11',
  pPeople_:()=>[{id:'MON-A',name:'Alice',active:true},{id:'MON-B',name:'Bob',active:true}],
  pQueueMail_:(id,to,subject,text)=>({table:'OUTBOX',record:{id,to,subject,text,status:'PENDING',revision:1}}),
  pWithLock_:fn=>fn()
 });
 vm.runInContext(code,ctx);return {ctx,props,db,requests,commits};
}
function token(extra={}) {
 const now=Math.floor(Date.now()/1000);
 const c={aud:'atoutsport-test',iss:'https://securetoken.google.com/atoutsport-test',sub:'uid-alice',exp:now+3600,iat:now,auth_time:now,...extra};
 return Buffer.from('{"alg":"RS256"}').toString('base64url')+'.'+Buffer.from(JSON.stringify(c)).toString('base64url')+'.'+'s'.repeat(200);
}
const director={id:'director',email:'jl@example.test',name:'la direction',role:'DIRECTOR',active:true};
const alice={id:'alice',email:'alice@example.test',name:'Alice',role:'MONITOR',monitorId:'MON-A',uid:'uid-alice',active:true,revision:1};

test('un jeton de mauvaise audience ou expiré est refusé avant tout appel externe',()=>{
 const {ctx,requests}=harness();
 assert.throws(()=>ctx.pVerifiedIdentity_(token({aud:'another-project'})),/incorrecte/);
 assert.throws(()=>ctx.pVerifiedIdentity_(token({exp:1})),/incorrecte/);
 assert.equal(requests.length,0);
});
test('le décodage local du JWT ne suffit pas : un refus Firebase est bloquant',()=>{
 const {ctx,requests}=harness({status:400});
 assert.throws(()=>ctx.pVerifiedIdentity_(token()),/expirée/);
 assert.equal(requests.length,1);
 assert.match(requests[0].url,/identitytoolkit\.googleapis\.com\/v1\/accounts:lookup/);
 assert.equal(JSON.parse(requests[0].request.payload).idToken,token());
});
test('Firebase doit confirmer le même UID, une adresse vérifiée et un compte actif',()=>{
 for(const identity of [
  {localId:'other-uid',email:alice.email,emailVerified:true},
  {localId:alice.uid,email:alice.email,emailVerified:false},
  {localId:alice.uid,email:alice.email,emailVerified:true,disabled:true}
 ])assert.throws(()=>harness({identity}).ctx.pVerifiedIdentity_(token()),/Vérifiez/);
 const {ctx}=harness();assert.deepEqual(clone(ctx.pVerifiedIdentity_(token())),{uid:alice.uid,email:alice.email});
});
test('une session authentifiée avant la révocation reste refusée même si son JWT vient d’être rafraîchi',()=>{
 const now=Math.floor(Date.now()/1000),cutoff=now-30;
 const identity={localId:alice.uid,email:alice.email,emailVerified:true,validSince:String(cutoff)};
 const {ctx}=harness({identity});
 assert.throws(()=>ctx.pVerifiedIdentity_(token({auth_time:cutoff-1,iat:now,exp:now+3600})),/révoquée/);
 assert.deepEqual(clone(ctx.pVerifiedIdentity_(token({auth_time:cutoff}))),{uid:alice.uid,email:alice.email});
 assert.deepEqual(clone(ctx.pVerifiedIdentity_(token({auth_time:cutoff+1}))),{uid:alice.uid,email:alice.email});
 for(const invalid of [undefined,null,'invalid',0,now+120])assert.throws(()=>ctx.pVerifiedIdentity_(token({auth_time:invalid})),/révoquée/);
 assert.throws(()=>harness({identity:{...identity,validSince:'not-a-timestamp'}}).ctx.pVerifiedIdentity_(token()),/révoquée/);
});
test('un jeton valide ne donne aucun rôle sans correspondance UID et email active',()=>{
 const {ctx,db}=harness({users:[alice]});
 assert.equal(ctx.pActor_({uid:alice.uid,email:alice.email}).role,'MONITOR');
 assert.throws(()=>ctx.pActor_({uid:'forged',email:alice.email}),/pas actif/);
 assert.throws(()=>ctx.pActor_({uid:alice.uid,email:'other@example.test'}),/pas actif/);
 db.USERS[0].active=false;assert.throws(()=>ctx.pActor_({uid:alice.uid,email:alice.email}),/pas actif/);
 db.USERS[0].active=true;db.USERS[0].deleted=true;assert.throws(()=>ctx.pActor_({uid:alice.uid,email:alice.email}),/pas actif/);
});
test('invitations : adresse destinataire, secret et expiration sont vérifiés',()=>{
 const secret='a'.repeat(64),hash=crypto.createHash('sha256').update(secret).digest('base64url');
 const pending={...alice,uid:'',inviteHash:hash,inviteExpiresAt:new Date(Date.now()+60000).toISOString()};
 const {ctx,db}=harness({users:[pending]});
 assert.throws(()=>ctx.pActivate_({uid:'uid-alice',email:'other@example.test'},{invitationToken:secret}),/introuvable/);
 assert.throws(()=>ctx.pActivate_({uid:'uid-alice',email:alice.email},{invitationToken:'b'.repeat(64)}),/expirée/);
 db.USERS[0].inviteExpiresAt='2000-01-01T00:00:00Z';
 assert.throws(()=>ctx.pActivate_({uid:'uid-alice',email:alice.email},{invitationToken:secret}),/expirée/);
});
test('activation consommée une seule fois ; aucun transfert du compte vers un autre UID',()=>{
 const secret='a'.repeat(64),hash=crypto.createHash('sha256').update(secret).digest('base64url');
 const {ctx,db,commits}=harness({users:[{...alice,uid:'',inviteHash:hash,inviteExpiresAt:new Date(Date.now()+60000).toISOString()}]});
 const identity={uid:alice.uid,email:alice.email};
 ctx.pActivate_(identity,{invitationToken:secret});
 assert.equal(db.USERS[0].uid,alice.uid);assert.equal(db.USERS[0].inviteHash,'');assert.equal(commits.length,1);
 ctx.pActivate_(identity,{invitationToken:secret});assert.equal(commits.length,1);
 assert.throws(()=>ctx.pActivate_({uid:'another',email:alice.email},{invitationToken:secret}),/autre connexion/);
});
test('les réponses publiques des comptes excluent UID et secrets invitation',()=>{
 const {ctx}=harness();const visible=ctx.pPublicUser_({...alice,inviteHash:'secret',inviteExpiresAt:'date'});
 assert.ok(!('uid' in visible));assert.ok(!('inviteHash' in visible));assert.ok(!('inviteExpiresAt' in visible));
});
test('seul le directeur gère les accès, sans pouvoir supprimer son compte de direction',()=>{
 const {ctx,db}=harness({users:[alice,{...director,revision:1}]});
 assert.throws(()=>ctx.pChangeUser_({...alice,role:'TECHNICAL'},{id:alice.id,revision:1,active:false}),/réservée/);
 assert.throws(()=>ctx.pChangeUser_(director,{id:director.id,revision:1,active:false}),/direction/);
 assert.throws(()=>ctx.pChangeUser_(director,{id:alice.id,revision:0,active:false}),/changé/);
 ctx.pChangeUser_(director,{id:alice.id,revision:1,active:false,deleted:true});
 assert.equal(db.USERS[0].active,false);assert.equal(db.USERS[0].deleted,true);assert.equal(db.USERS[0].uid,alice.uid);
});
test('une invitation ne permet pas de créer un second directeur ou un compte piscine inexistant',()=>{
 const {ctx}=harness();
 assert.throws(()=>ctx.pInviteUser_(director,{email:'new@example.test',name:'New',role:'DIRECTOR'}),/Rôle/);
 assert.throws(()=>ctx.pInviteUser_(director,{email:'new@example.test',name:'New',role:'MONITOR',monitorId:'UNKNOWN'}),/personne active/);
});
test('la RPC relit les droits sous verrou et refuse une révocation simultanée',()=>{
 const {ctx,db}=harness({users:[alice]});
 const handlers=['pMonth_','pSaveDraft_','pSubmit_','pDashboard_','pReview_','pRecoveries_','pSaveRecovery_','pAssignRecovery_','pDocuments_','pUploadDocument_','pDownloadDocument_','pReviewDocument_','pMailLog_','pRetryMail_','pLegacyUi_','pLegacy_','pGetIdentity_','pRevealIdentity_','pSubmitIdentity_','pReviewIdentity_','pGetProfile_','pSaveProfile_','pRequestProfileEmail_','pCompleteProfileEmail_','pCloseMonth_','pMonthlyStatus_','pRetryPdf_','pDisputes_','pCreateDispute_','pResolveDispute_'];
 for(const key of handlers)ctx[key]=()=>({});
 let entered=false;ctx.pWithLock_=fn=>{entered=true;db.USERS[0].active=false;return fn();};
 vm.runInContext(main,ctx);
 const result=ctx.portalRpc(token(),'bootstrap',{});
 assert.equal(entered,true);assert.equal(result.ok,false);assert.match(result.error,/pas actif/);
});
test('surface publique limitée à la page, sa configuration et le point RPC authentifié',()=>{
 const exposed=[];
 for(const file of fs.readdirSync(path.join(__dirname,'../apps-script')).filter(f=>f.endsWith('.gs'))){
  const source=fs.readFileSync(path.join(__dirname,'../apps-script',file),'utf8');
  for(const match of source.matchAll(/^function\s+(\w+)\s*\(/gm))if(!match[1].endsWith('_'))exposed.push(match[1]);
 }
 assert.deepEqual(exposed.sort(),['doGet','getPortalConfig','portalRpc']);
});
test('le pont ancien admin refuse les moniteurs et réserve les validations à la direction',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../apps-script/LegacyAdmin.gs'),'utf8');
 const ctx=vm.createContext({console});vm.runInContext(source,ctx);
 const manager={id:'manager',role:'MANAGER',active:true};
 assert.throws(()=>ctx.pLegacyAccess_({id:'monitor',role:'MONITOR',active:true},{method:'bootstrap',args:[]}),/responsables/);
 assert.throws(()=>ctx.pLegacyAccess_({...manager,active:false},{method:'bootstrap',args:[]}),/responsables/);
 assert.throws(()=>ctx.pLegacyAccess_(manager,{method:'constructor',args:[]}),/non autorisée/);
 for(const method of ['closePayroll','reopenPayroll','uploadSignedContract']){
  assert.throws(()=>ctx.pLegacyAccess_(manager,{method,args:[]}),/direction/);
  assert.equal(ctx.pLegacyAccess_({...manager,role:'DIRECTOR'},{method,args:[]}).method,method);
 }
 for(const method of ['previewStudentContract','generateStudentContract']){
  assert.throws(()=>ctx.pLegacyAccess_(manager,{method,args:[{employerSigned:true}]}),/direction/);
  assert.throws(()=>ctx.pLegacyAccess_(manager,{method,args:[{validated:true}]}),/direction/);
  assert.equal(ctx.pLegacyAccess_(manager,{method,args:[{validated:false,employerSigned:false}]}).method,method);
 }
 assert.throws(()=>ctx.pLegacyAccess_(manager,{method:'saveSport',args:['SUIVI_MENSUEL',{StatutFiche:'VALIDEE'}]}),/direction/);
});


test('email de direction résolu depuis le compte actif, sans destinataire ancien',()=>{
 const {ctx,db}=harness({users:[{...director,uid:'uid-director',email:'nouveau@example.test'}]});
 assert.equal(ctx.pDirectorEmail_(),'nouveau@example.test');
 db.USERS[0].active=false;assert.throws(()=>ctx.pDirectorEmail_(),/direction/);
 db.USERS[0].active=true;db.USERS.push({...db.USERS[0],id:'director-duplicate'});assert.throws(()=>ctx.pDirectorEmail_(),/direction/);
});
test('invitation ne consomme pas une adresse réservée par un changement vérifié en cours',()=>{
 const {ctx}=harness({users:[{...alice,pendingEmail:{email:'reserved@example.test'}}]});
 assert.throws(()=>ctx.pInviteUser_(director,{name:'Other',email:'reserved@example.test',role:'MANAGER'}),/réservée/);
});

test('le directeur invité peut recevoir les notifications avant son activation Firebase',()=>{
 const {ctx}=harness({users:[{...director,uid:'',email:'direction@example.test'}]});
 assert.equal(ctx.pDirectorEmail_(),'direction@example.test');
});


test('le second compte direction ne détourne pas les notifications de la direction',()=>{
 const owner={id:'owner',email:'direction@example.test',role:'DIRECTOR',active:true};
 const {ctx,db}=harness({users:[{...director,uid:'jl'},owner],props:{OWNER_ACCOUNT_ID:'owner',DIRECTOR_NOTIFICATION_USER_ID:'director'}});
 assert.equal(ctx.pDirectorEmail_(),director.email);
 db.USERS[0].email='jl-updated@example.test';assert.equal(ctx.pDirectorEmail_(),'jl-updated@example.test');
 db.USERS[0].active=false;assert.throws(()=>ctx.pDirectorEmail_(),/direction/);
 assert.throws(()=>ctx.pChangeUser_(director,{id:'owner',revision:1,active:false}),/changé|direction/);
});
test('invitation et rôles responsables vérifient aussi la personne associée',()=>{
 const {ctx}=harness();
 const result=ctx.pInviteUser_(director,{name:'Alice',email:'alice@example.test',role:'MONITOR',monitorId:'MON-A'});
 assert.equal(result.user.monitorId,'MON-A');
 assert.throws(()=>ctx.pInviteUser_(director,{name:'Other',email:'other@example.test',role:'SECRETARY',monitorId:'UNKNOWN'}),/personne active/);
});
