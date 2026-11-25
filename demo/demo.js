/* Démonstration locale uniquement : personnes et numéros fictifs, aucun email envoyé.
 * Ce fichier ne doit jamais être inclus dans le déploiement Apps Script. */
(()=>{
const clone=x=>JSON.parse(JSON.stringify(x));
const params=new URLSearchParams(location.search);
const today='2026-11-25';
const people=[
 {id:'DEMO01',name:'Camille Martin',active:true,sourceMode:'POOL',sectors:['PISCINE','STAGE','EXTRASPORT']},
 {id:'DEMO02',name:'Lucas Bernard',active:true,sourceMode:'POOL',sectors:['PISCINE','STAGE','EXTRASPORT']},
 {id:'DEMO03',name:'Sarah Laurent',active:true,sourceMode:'POOL',sectors:['PISCINE','STAGE','EXTRASPORT']},
 {id:'DEMO04',name:'Léa Durand',active:true,sourceMode:'MANUAL',sectors:['STAGE','EXTRASPORT']}
];
const activities=['Natation','Bébés nageurs','Aquagym','Aquafit','Stage','Extrasport','Danse','Gestion administrative','Direction','Secrétariat','Comptabilité'];
const role=params.get('role')||'DIRECTOR',own=params.get('person')==='manual'?'DEMO04':'DEMO01';
const actor={id:'DEMO_USER',email:'demo@example.invalid',name:role==='MONITOR'?people.find(p=>p.id===own).name:'Direction · Démonstration',role,monitorId:own,active:true};
const staff=['DIRECTOR','MANAGER','SECRETARY'].includes(role);
const records=new Map(),identities=new Map();
const documents=[{id:'doc-demo',monitorId:'DEMO01',title:'Contrat piscine — exemple fictif',category:'CONTRAT',visibility:'PRIVATE',status:'AWAITING_SIGNATURE',contractStatus:'NON_SIGNE',createdAt:'2026-11-03T10:15:00Z',revision:1,contractRef:'',legacy:true,readOnly:true}];
let users=[{...actor,activated:true,revision:1},{id:'DEMO_U2',email:'responsable@example.invalid',name:'Responsable fictif',role:'MANAGER',active:true,activated:true,revision:1}];
let recoveries=[];
let profile={revision:1,monitorId:own,firstName:own==='DEMO04'?'Léa':'Camille',lastName:own==='DEMO04'?'Durand':'Martin',email:actor.email,phone:'',address:'Adresse fictive',sourceRevision:'demo-source-1',syncStatus:'SYNCED',pendingEmail:null,editable:true};
function sourceMode(id){return people.find(p=>p.id===id)?.sourceMode||'POOL'}
function deadline(month){const d=new Date(month+'-01T12:00:00Z');return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,-1)).toISOString().slice(0,10)}
function correctionDeadline(month){const d=new Date(month+'-01T12:00:00Z');return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,5)).toISOString().slice(0,10)}
function reminderDates(month){return [7,3,1].map(n=>new Date(new Date(deadline(month)+'T12:00:00Z').getTime()-n*86400000).toISOString().slice(0,10))}
function expected(month,id){return sourceMode(id)==='MANUAL'?[]:[{id:'expected:p1',date:month+'-03',start:'08:30',end:'13:00',breakMinutes:0,type:'NORMAL',activity:'Natation',origin:'Planning piscine'},{id:'expected:p2',date:month+'-06',start:'16:15',end:'19:30',breakMinutes:0,type:'NORMAL',activity:'Natation',origin:'Planning piscine'}]}
function sheet(month,id){const key=id+'__'+month;if(!records.has(key))records.set(key,{id:key,month,monitorId:id,sourceMode:sourceMode(id),status:id==='DEMO02'?'SUBMITTED':id==='DEMO03'?'APPROVED':'DRAFT',revision:1,lines:expected(month,id).map(l=>({...l,id:crypto.randomUUID()})),comment:'',declarationNote:'',expectedSnapshot:expected(month,id)});return records.get(key)}
function mins(l){const m=x=>Number(x.slice(0,2))*60+Number(x.slice(3));return m(l.end)-m(l.start)-Number(l.breakMinutes||0)}
function forecast(lines){const future=lines.filter(l=>l.date>today);return {lineCount:future.length,workedMinutes:future.filter(l=>l.type!=='ABSENCE').reduce((n,l)=>n+mins(l),0),absenceMinutes:future.filter(l=>l.type==='ABSENCE').reduce((n,l)=>n+mins(l),0),dates:[...new Set(future.map(l=>l.date))]}}
function view(s){
 const exp=expected(s.month,s.monitorId),manual=s.sourceMode==='MANUAL',isPool=l=>['Natation','Bébés nageurs','Aquagym','Aquafit'].includes(l.activity),workedRows=s.lines.filter(l=>l.type!=='ABSENCE');
 const worked=workedRows.reduce((n,l)=>n+mins(l),0),pool=manual?0:workedRows.filter(isPool).reduce((n,l)=>n+mins(l),0),absence=s.lines.filter(l=>l.type==='ABSENCE').reduce((n,l)=>n+mins(l),0),planned=exp.reduce((n,l)=>n+mins(l),0),f=forecast(s.lines);
 const canEdit=s.monitorId===actor.monitorId&&(s.status==='RETURNED'||['DRAFT','SUBMITTED'].includes(s.status)&&(!s.submittedAt||today<=correctionDeadline(s.month)));
 const dates=[...new Set([...exp,...s.lines].map(x=>x.date))].sort();
 return {monthlyEnabled:false,closeDate:correctionDeadline(s.month).slice(0,8)+'06',today,exists:true,sheet:clone(s),sourceMode:s.sourceMode,hasPlanningBaseline:!manual,activities,expected:exp,canEdit,canSubmit:canEdit&&['DRAFT','RETURNED'].includes(s.status)&&s.month<=today.slice(0,7)&&(!f.lineCount||today>=reminderDates(s.month)[0]),canApprove:role==='DIRECTOR'&&s.status==='SUBMITTED'&&s.month<today.slice(0,7),canCorrectSubmission:canEdit&&s.status==='SUBMITTED',canReturn:staff&&(s.status==='SUBMITTED'||s.status==='DRAFT'&&!!s.submittedAt),requiresResubmission:s.status==='DRAFT'&&!!s.submittedAt,deadline:deadline(s.month),correctionDeadline:correctionDeadline(s.month),reminderDates:reminderDates(s.month),submissionOpensOn:reminderDates(s.month)[0],hasForecast:f.lineCount>0,forecast:f,
 summary:{workedMinutes:worked,poolWorkedMinutes:pool,manualWorkedMinutes:worked-pool,absenceMinutes:absence,expectedMinutes:manual?null:planned,differenceMinutes:manual?null:pool-planned,payableMinutes:worked,alreadyPaidMinutes:0,performedMinutes:worked-f.workedMinutes,forecastMinutes:f.workedMinutes,warnings:[],byDate:dates.map(date=>{const rows=s.lines.filter(l=>l.date===date&&l.type!=='ABSENCE'),workedMinutes=rows.reduce((n,l)=>n+mins(l),0),poolWorkedMinutes=manual?0:rows.filter(isPool).reduce((n,l)=>n+mins(l),0),expectedMinutes=exp.filter(l=>l.date===date).reduce((n,l)=>n+mins(l),0);return {date,expectedMinutes:manual?null:expectedMinutes,workedMinutes,poolWorkedMinutes,manualWorkedMinutes:workedMinutes-poolWorkedMinutes,differenceMinutes:manual?null:poolWorkedMinutes-expectedMinutes}})},
 finance:staff?{provisional:s.status!=='APPROVED',rate:15,grossCents:s.status==='APPROVED'?Math.round(worked*25):null,dueCents:s.status==='APPROVED'?Math.round(worked*25):null,paidCents:0,balanceCents:s.status==='APPROVED'?Math.round(worked*25):null,estimatedGrossCents:Math.round(worked*25),estimatedDueCents:Math.round(worked*25),warnings:[]}:null};
}
function identityRecord(id){if(!people.some(p=>p.id===id)||!staff&&id!==actor.monitorId)throw Error('Accès non autorisé dans la démonstration.');if(!identities.has(id))identities.set(id,{revision:0,status:'MISSING',niss:'',pendingNiss:'',submittedAt:'',reviewedAt:'',reviewReason:''});return identities.get(id)}
function identityView(id){const r=identityRecord(id);return {monitorId:id,name:people.find(p=>p.id===id).name,revision:r.revision,status:r.status,hasNiss:!!r.niss,maskedNiss:r.niss?'•••••••'+r.niss.slice(-4):'',hasPending:!!r.pendingNiss,pendingMaskedNiss:r.pendingNiss?'•••••••'+r.pendingNiss.slice(-4):'',submittedAt:r.submittedAt,reviewedAt:r.reviewedAt,reviewReason:r.reviewReason,canSubmit:!r.pendingNiss,canReview:role==='DIRECTOR'&&!!r.pendingNiss}}
async function route(action,p){
 if(action==='completeProfileEmail')return {actor,completed:false,syncStatus:'SYNCED'};
 if(action==='getProfile')return clone(profile);
 if(action==='saveProfile'){if(p.revision!==profile.revision)throw Error('Vos coordonnées ont changé. Actualisez.');profile={...profile,phone:p.phone,address:p.address,revision:profile.revision+1};return clone(profile)}
 if(action==='bootstrap')return {monthlyEnabled:false,actor,team:people.filter(p=>p.sourceMode==='POOL'),people,activities,today,month:'2026-10',notificationsEnabled:false};
 if(action==='getIdentity')return identityView(p.monitorId||actor.monitorId);
 if(action==='revealIdentity'){const id=p.monitorId||actor.monitorId,r=identityRecord(id);return {...identityView(id),niss:r.niss,pendingNiss:r.pendingNiss}}
 if(action==='submitIdentity'){const id=p.monitorId||actor.monitorId,r=identityRecord(id);if(r.revision!==p.revision||r.pendingNiss)throw Error('La fiche a changé ou une proposition attend déjà sa validation.');r.pendingNiss=p.niss;r.status='PENDING';r.submittedAt=new Date().toISOString();r.revision++;return identityView(id)}
 if(action==='reviewIdentity'){if(role!=='DIRECTOR')throw Error('Validation réservée à la direction.');const r=identityRecord(p.monitorId);if(r.revision!==p.revision||!r.pendingNiss)throw Error('Aucune proposition à valider.');if(p.decision==='REJECT'&&!p.reason)throw Error('Un motif est requis.');if(p.decision==='APPROVE')r.niss=r.pendingNiss;r.pendingNiss='';r.status=p.decision==='APPROVE'?'VERIFIED':'REJECTED';r.reviewReason=p.reason||'';r.reviewedAt=new Date().toISOString();r.revision++;return identityView(p.monitorId)}
 if(action==='month')return view(sheet(p.month,p.monitorId||actor.monitorId));
 if(action==='saveDraft'){const s=sheet(p.month,p.monitorId||actor.monitorId);if(s.revision!==p.revision)throw Error('La fiche a changé.');if(!view(s).canEdit)throw Error('Fiche verrouillée dans cette démonstration.');s.lines=clone(p.lines);s.declarationNote=p.declarationNote||'';if(s.status==='SUBMITTED')s.status='DRAFT';s.revision++;return view(s)}
 if(action==='submit'){const s=records.get(p.sheetId),v=view(s);if(!v.canSubmit)throw Error('Envoi non ouvert pour cette fiche.');if(v.hasForecast&&p.forecastAcknowledged!==true)throw Error('Confirmez les heures prévisionnelles.');s.status='SUBMITTED';s.forecastAtSubmission=v.forecast;s.submissionCount=Number(s.submissionCount||0)+1;s.submittedAt=new Date().toISOString();s.revision++;return view(s)}
 if(action==='review'){const s=records.get(p.sheetId);
 if(p.revision!==s.revision)throw Error('La fiche a changé. Rechargez-la.');
 if(p.decision==='CORRECT'){
  if(role!=='DIRECTOR')throw Error('Action réservée à la direction.');
  if(s.status==='APPROVED')throw Error('Rouvrez la fiche avant de la corriger.');
  if(!String(p.comment||'').trim())throw Error('Un motif est obligatoire.');
  s.lines=clone(p.lines);s.declarationNote=String(p.declarationNote||'');s.status='SUBMITTED';
  s.directorCorrection={name:actor.name,actorId:actor.id,at:new Date().toISOString(),reason:p.comment};s.revision++;return view(s);
 }
 if(p.decision==='APPROVE'&&!view(s).canApprove)throw Error('Validation finale indisponible.');s.status={RETURN:'RETURNED',APPROVE:'APPROVED',REOPEN:'RETURNED'}[p.decision];s.comment=p.comment;s.revision++;return view(s)}
 if(action==='dashboard')return {month:p.month,deadline:deadline(p.month),correctionDeadline:correctionDeadline(p.month),reminderDates:reminderDates(p.month),rows:people.map(m=>{const s=sheet(p.month,m.id),v=view(s);if(!(v.summary.workedMinutes>0||m.active&&v.summary.expectedMinutes>0||v.expected.some(l=>(l.replacedMonitorId||String(l.origin||'').startsWith('REMPLACEMENT:'))&&mins(l)>0)))return null;return {monitorId:m.id,name:m.name,sourceMode:v.sourceMode,hasPlanningBaseline:v.hasPlanningBaseline,status:s.status,sheetId:s.id,revision:s.revision,late:today>deadline(p.month)&&s.status==='DRAFT',...v.summary,hasForecast:v.hasForecast,forecast:v.forecast,dueCents:v.finance?.dueCents,paidCents:0,balanceCents:v.finance?.balanceCents}}).filter(Boolean)};
 if(action==='documents')return {rows:documents.filter(d=>staff||d.visibility==='PRIVATE'&&d.monitorId===actor.monitorId||d.visibility==='POOL'&&sourceMode(actor.monitorId)==='POOL')};
 if(action==='uploadDocument'){const d={id:crypto.randomUUID(),...p,status:'TO_REVIEW',createdAt:new Date().toISOString(),revision:1,monitorId:p.monitorId||actor.monitorId};documents.push(d);return d}
 if(action==='downloadDocument'){const d=documents.find(x=>x.id===p.id);if(d.base64)return {filename:d.filename,mime:d.mime,base64:d.base64};return {filename:'exemple.txt',mime:'text/plain',base64:btoa('Document de demonstration uniquement.')}}
 if(action==='reviewDocument'){const d=documents.find(x=>x.id===p.id);d.status=p.status;d.revision++;return d}
 if(action==='recoveries')return {rows:recoveries.filter(r=>staff?(!p.monitorId||r.monitorId===p.monitorId):r.monitorId===actor.monitorId)};
 if(action==='saveRecovery'){const r={...p.record,id:crypto.randomUUID(),revision:1,usedMinutes:0,remainingMinutes:p.record.minutes};recoveries.push(r);return r}
 if(action==='assignRecovery'){const s=records.get(p.sheetId);s.lines.find(l=>l.id===p.lineId).recoveryId=p.recoveryId;s.revision++;return view(s)}
 if(action==='users')return {rows:users};
 if(action==='inviteUser'){const u={...p,id:crypto.randomUUID(),revision:1,active:true};users.push(u);return {user:u,queued:true}}
 if(action==='changeUser'){const u=users.find(x=>x.id===p.id);Object.assign(u,p,{revision:u.revision+1});return u}
 if(action==='diagnostic')return {configured:true,notificationsEnabled:false,pending:2,failed:0,sourceCheckedAt:today+'T11:00:00Z',poolMonitors:3,version:'1.0.1 — démonstration'};
 if(action==='completeGuide'){actor.guideVersion=35;return {completed:true};}
 if(action==='monthlyStatus')return {installed:true,enabled:false,closeDay:6,rows:[],lastRun:''};
 if(action==='disputes')return {rows:[]};
 if(action==='createDispute')return {rows:[]};
 if(action==='mailLog')return {rows:[{id:'demo-mail',to:'direction@example.invalid',subject:'Nouvelle fiche — exemple',status:'PENDING',revision:1}]};
 if(action==='legacyUi')return {html:'<!doctype html><html lang="fr"><body style="font:16px system-ui;padding:32px;color:#123f50"><h1>Administration existante</h1><p>Dans la version configurée, cet espace affiche les équipes, plannings, contrats et contenus TV, avec les droits du compte connecté.</p><p>Démonstration locale : aucune donnée réelle n’est chargée.</p></body></html>'};
 throw Error('Action non disponible dans la démonstration.');
}
window.PORTAL_DEMO_BRIDGE=async(fn,...args)=>{await new Promise(r=>setTimeout(r,60));if(fn==='getPortalConfig')return {configured:true,title:'AtoutSport',firebase:{},appUrl:''};if(fn==='portalRpc'){try{return {ok:true,data:clone(await route(args[1],args[2]||{}))}}catch(e){return {ok:false,error:e.message}}}throw Error('Action inconnue')};
})();
