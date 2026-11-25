const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../apps-script/Mail.gs'),'utf8');
const clone=x=>JSON.parse(JSON.stringify(x));
const director={id:'jl',role:'DIRECTOR'};
function harness(){
 const data=[],users=[],sheets=[],team=[],tables={OUTBOX:data,USERS:users,TIMESHEETS:sheets},sent=[],actions=[],props={APP_EMAIL_ENABLED:'true',APP_URL:'https://script.google.com/macros/s/test-portal/exec'};
 let now=Date.parse('2026-11-11T14:00:00Z'),quota=100;
 class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
 const c={Date:Clock,pProperties_:()=>({getProperty:key=>props[key]||null}),pNow_:()=>new Clock().toISOString(),pToday_:()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Brussels',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Clock()),pWithLock_:fn=>fn(),pRows_:name=>clone(tables[name]||[]),pGet_:(name,id)=>clone((tables[name]||[]).find(m=>m.id===id)||null),pTeam_:()=>clone(team.filter(p=>p.sourceMode!=='MANUAL')),pPeople_:()=>clone(team),pLineMinutes_:line=>{const minute=s=>Number(s.slice(0,2))*60+Number(s.slice(3));return minute(line.end)-minute(line.start)-Number(line.breakMinutes||0);},pDirector_:actor=>{if(actor.role!=='DIRECTOR')throw Error('Direction seulement.');},MailApp:{getRemainingDailyQuota:()=>quota,sendEmail:mail=>{sent.push(clone(mail));quota--;}}};
 c.pCommit_=(changes,_actor,action)=>{for(const {table,record}of changes){const target=tables[table]||(tables[table]=[]),i=target.findIndex(m=>m.id===record.id);if(i<0)target.push(clone(record));else target[i]=clone(record);}actions.push(action);};
 vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(__dirname,'../apps-script/Domain.gs'),'utf8'),c);vm.runInContext(source,c);
 function queue(id='notice-1'){c.pCommit_([c.pQueueMail_(id,'jl@example.test','Fiche envoyée','Consultez la fiche.')],director,'QUEUE');return data.find(x=>x.id===id);}
 function addMonitor(id='mon-1',email='alice@example.test'){const user={id:'u-'+id,email,name:'Alice Exemple',role:'MONITOR',monitorId:id,active:true,deleted:false,uid:'uid-'+id};users.push(user);team.push({id,name:user.name,active:true});return user;}
 return {c,data,users,sheets,team,sent,actions,props,queue,addMonitor,advance:ms=>now+=ms,setNow:date=>now=Date.parse(date),setQuota:n=>quota=n};
}
test('outbox idempotente : le même événement ne recrée ni ne renvoie un email livré',()=>{
 const h=harness();h.queue();h.c.pDeliverMail_();h.queue();h.c.pDeliverMail_();
 assert.equal(h.data.length,1);assert.equal(h.sent.length,1);assert.equal(h.data[0].status,'SENT');assert.equal(h.data[0].text,'');
});
test('notifications désactivées : aucune modification et aucun envoi',()=>{
 const h=harness();h.queue();h.props.APP_EMAIL_ENABLED='false';
 assert.equal(h.c.pDeliverMail_().disabled,true);assert.equal(h.sent.length,0);assert.equal(h.data[0].status,'PENDING');assert.equal(h.data[0].attempts,0);
});
test('une désactivation pendant l’attente du verrou empêche aussi l’envoi',()=>{
 const h=harness();h.queue();h.c.pWithLock_=fn=>{h.props.APP_EMAIL_ENABLED='false';return fn();};
 assert.equal(h.c.pDeliverMail_().disabled,true);assert.equal(h.sent.length,0);
});
test('quota épuisé : message conservé sans tentative ; reprise quand le quota revient',()=>{
 const h=harness();h.queue();h.setQuota(0);h.c.pDeliverMail_();assert.equal(h.data[0].status,'PENDING');assert.equal(h.data[0].attempts,0);
 h.setQuota(1);h.c.pDeliverMail_();assert.equal(h.sent.length,1);assert.equal(h.data[0].status,'SENT');
});
test('lien du portail ajouté une seule fois ; URL de configuration invalide jamais ajoutée',()=>{
 const h=harness();h.queue();h.c.pDeliverMail_();assert.equal(h.sent[0].body.split(h.props.APP_URL).length-1,1);
 h.c.pCommit_([h.c.pQueueMail_('with-link','jl@example.test','Fiche','Lien '+h.props.APP_URL)],director,'QUEUE');h.c.pDeliverMail_();assert.equal(h.sent[1].body.split(h.props.APP_URL).length-1,1);
 h.props.APP_URL='javascript:alert(1)';h.queue('invalid-link');h.c.pDeliverMail_();assert.equal(h.sent[2].body,'Consultez la fiche.');
});
test('erreur réseau pendant l’envoi : FAILED, aucune relance automatique',()=>{
 const h=harness();h.queue();let attempts=0;h.c.MailApp.sendEmail=()=>{attempts++;throw Error('Network timeout after delivery unknown');};
 h.c.pDeliverMail_();h.c.pDeliverMail_();assert.equal(attempts,1);assert.equal(h.data[0].status,'FAILED');assert.equal(h.data[0].attempts,1);
 assert.ok(!h.data[0].error.includes('Network timeout'));
});
test('échec du commit après envoi : SENDING puis UNKNOWN, jamais de doublon automatique',()=>{
 const h=harness();h.queue();const commit=h.c.pCommit_;h.c.pCommit_=(changes,actor,action)=>{if(action==='MAIL_ENVOYE')throw Error('Sheets unavailable');return commit(changes,actor,action);};
 assert.throws(()=>h.c.pDeliverMail_(),/Sheets unavailable/);assert.equal(h.sent.length,1);assert.equal(h.data[0].status,'SENDING');
 h.c.pCommit_=commit;h.c.pDeliverMail_();assert.equal(h.sent.length,1);h.advance(16*60000);h.c.pDeliverMail_();assert.equal(h.data[0].status,'UNKNOWN');assert.equal(h.sent.length,1);
});
test('réponse de commit perdue après écriture SENT : un nouvel appel ne renvoie pas',()=>{
 const h=harness();h.queue();const commit=h.c.pCommit_;h.c.pCommit_=(changes,actor,action)=>{commit(changes,actor,action);if(action==='MAIL_ENVOYE')throw Error('Lost response');};
 assert.throws(()=>h.c.pDeliverMail_(),/Lost response/);assert.equal(h.data[0].status,'SENT');h.c.pCommit_=commit;h.c.pDeliverMail_();assert.equal(h.sent.length,1);
});
test('échec de réservation avant sendEmail : aucune livraison ; la prochaine exécution peut reprendre',()=>{
 const h=harness();h.queue();const commit=h.c.pCommit_;h.c.pCommit_=(changes,actor,action)=>{if(action==='MAIL_DEBUT')throw Error('Storage failure');return commit(changes,actor,action);};
 assert.throws(()=>h.c.pDeliverMail_(),/Storage failure/);assert.equal(h.sent.length,0);assert.equal(h.data[0].status,'PENDING');h.c.pCommit_=commit;h.c.pDeliverMail_();assert.equal(h.sent.length,1);
});
test('relance manuelle : directeur, version et justification obligatoires ; aucun envoi immédiat',()=>{
 const h=harness();h.queue();Object.assign(h.data[0],{status:'UNKNOWN',revision:3});
 assert.throws(()=>h.c.pRetryMail_({role:'MANAGER'},{id:'notice-1',revision:3,reason:'Vérifié'}),/Direction/);
 assert.throws(()=>h.c.pRetryMail_(director,{id:'notice-1',revision:2,reason:'Vérifié'}),/non relançable/);
 assert.throws(()=>h.c.pRetryMail_(director,{id:'notice-1',revision:3,reason:' '}),/vérification/);
 assert.equal(h.c.pRetryMail_(director,{id:'notice-1',revision:3,reason:'Aucun email reçu après vérification'}).queued,true);assert.equal(h.sent.length,0);assert.equal(h.data[0].status,'PENDING');assert.equal(h.data[0].revision,4);
 h.c.pDeliverMail_();assert.equal(h.sent.length,1);assert.throws(()=>h.c.pRetryMail_(director,{id:'notice-1',revision:6,reason:'Encore'}),/non relançable/);
});
test('journal réservé au directeur et sans corps contenant les liens d’invitation',()=>{
 const h=harness();h.queue();assert.throws(()=>h.c.pMailLog_({role:'TECHNICAL'}),/Direction/);const log=h.c.pMailLog_(director);assert.equal(log.rows[0].text,undefined);assert.equal(log.rows[0].to,'jl@example.test');
});
test('chaque lot est borné à dix emails et respecte une date de prochaine tentative',()=>{
 const h=harness();for(let i=0;i<12;i++)h.queue('mail-'+i);h.data[0].nextAttemptAt='2026-11-12T00:00:00Z';
 h.c.pDeliverMail_();assert.equal(h.sent.length,10);assert.equal(h.data[0].status,'PENDING');assert.equal(h.data.filter(m=>m.status==='PENDING').length,2);
});

test('rappels seulement J-7, J-3 et J-1, sans rattrapage ni report sur le mois suivant',()=>{
 const h=harness(),window=date=>clone(h.c.pMailReminderWindow_(date));
 for(const [month,days,last]of [['2027-02',[20,24,26],28],['2028-02',[21,25,27],29],['2026-11',[22,26,28],30],['2026-12',[23,27,29],31]]){
  for(let day=1;day<=last;day++){
   const date=month+'-'+String(day).padStart(2,'0'),value=window(date);
   if(days.includes(day))assert.deepEqual(value,{month,scheduledOn:date,expiresOn:date,deadline:month+'-'+String(last-1),reminderPolicy:'MONTH_END_V1'});
   else assert.equal(value,null,date);
  }
 }
 assert.equal(window('2027-01-03'),null);
 assert.throws(()=>window('2026-02-30'),/Date de rappel/);
});

test('rappel idempotent par moniteur/mois/jalon, exactement trois envois possibles en novembre',()=>{
 const h=harness();h.addMonitor();h.setNow('2026-11-22T08:00:00Z');
 assert.equal(h.c.pPrepareReminders_().prepared,1);assert.equal(h.c.pPrepareReminders_().prepared,0);
 assert.equal(h.sent.length,0);assert.equal(h.data[0].expiresOn,'2026-11-22');assert.equal(h.data[0].deadline,'2026-11-29');
 h.c.pDeliverMail_();h.setNow('2026-11-23T08:00:00Z');assert.equal(h.c.pPrepareReminders_().prepared,0);
 h.setNow('2026-11-26T08:00:00Z');assert.equal(h.c.pPrepareReminders_().prepared,1);h.c.pDeliverMail_();
 h.setNow('2026-11-28T08:00:00Z');assert.equal(h.c.pPrepareReminders_().prepared,1);h.c.pDeliverMail_();
 h.setNow('2026-12-01T08:00:00Z');assert.equal(h.c.pPrepareReminders_().prepared,0);h.c.pDeliverMail_();
 assert.equal(h.sent.length,3);assert.equal(h.data.at(-1).month,'2026-11');
 assert.ok(h.sent.every(m=>m.body.includes('29/11/2026')&&m.body.includes('jusqu’au 5')));
});

test('la date locale de Bruxelles régit les rappels, en heure d’hiver et d’été',()=>{
 for(const [before,after,localDate]of [['2026-11-21T22:59:00Z','2026-11-21T23:00:00Z','2026-11-22'],['2026-07-22T21:59:00Z','2026-07-22T22:00:00Z','2026-07-23']]){
  const h=harness();h.addMonitor();h.setNow(before);assert.equal(h.c.pPrepareReminders_().prepared,0);
  h.setNow(after);assert.equal(h.c.pToday_(),localDate);assert.equal(h.c.pPrepareReminders_().prepared,1);
  h.advance(86400000);assert.equal(h.c.pPrepareReminders_().prepared,0);assert.equal(h.data[0].status,'CANCELLED');
 }
});

test('rappels ciblent seulement les comptes activés et moniteurs piscine actifs dont la fiche reste ouverte',()=>{
 const h=harness();h.setNow('2026-11-22T08:00:00Z');
 const statuses=['DRAFT','RETURNED','SUBMITTED','APPROVED'];
 for(const [i,status]of statuses.entries()){const u=h.addMonitor('m'+i);h.sheets.push({id:'sheet-'+i,monitorId:u.monitorId,month:'2026-11',status});}
 const off=h.addMonitor('inactive');off.active=false;
 const deleted=h.addMonitor('deleted');deleted.deleted=true;
 const unactivated=h.addMonitor('unactivated');unactivated.uid='';
 h.addMonitor('stage');h.team.find(m=>m.id==='stage').active=false;
 h.users.push({id:'extra',monitorId:'extra-stage',uid:'uid-extra',email:'stage@example.test',active:true});
 const missing=h.addMonitor('missing');
 assert.equal(h.c.pPrepareReminders_().prepared,3);
 assert.deepEqual(h.data.map(m=>m.monitorId),['m0','m1',missing.monitorId]);
});

test('envoi déjà soumis, accès retiré, équipe inactive ou échéance passée annule le rappel en attente',()=>{
 for(const mode of ['submitted','approved','disabled','deleted','inactive-pool','expired']){
  const h=harness(),u=h.addMonitor();h.setNow('2026-11-22T08:00:00Z');h.c.pPrepareReminders_();
  if(['submitted','approved'].includes(mode))h.sheets.push({id:'s',monitorId:u.monitorId,month:'2026-11',status:mode==='submitted'?'SUBMITTED':'APPROVED'});
  if(mode==='disabled')u.active=false;if(mode==='deleted')u.deleted=true;if(mode==='inactive-pool')h.team[0].active=false;if(mode==='expired')h.setNow('2026-12-06T08:00:00Z');
  const result=h.c.pDeliverMail_();assert.equal(h.sent.length,0,mode);assert.equal(result.cancelled,1,mode);assert.equal(h.data[0].status,'CANCELLED',mode);
 }
});

test('ancienne attente de quota remplacée par le dernier rappel, pas de rafale de rappels',()=>{
 const h=harness();h.addMonitor();h.setNow('2026-11-22T08:00:00Z');h.c.pPrepareReminders_();h.setQuota(0);h.c.pDeliverMail_();
 h.setNow('2026-11-28T08:00:00Z');h.c.pPrepareReminders_();assert.equal(h.data[0].status,'CANCELLED');assert.equal(h.data[1].status,'PENDING');
 h.setQuota(10);h.c.pDeliverMail_();assert.equal(h.sent.length,1);assert.equal(h.data[1].status,'SENT');
});

test('changement vérifié d’adresse : rappels et accusés en attente sont livrés uniquement à l’adresse actuelle',()=>{
 const h=harness(),u=h.addMonitor();h.setNow('2026-11-22T08:00:00Z');h.c.pPrepareReminders_();
 const sheet={id:'s',month:'2026-11',monitorId:u.monitorId,revision:2,submissionCount:1,lines:[{date:'2026-11-02',start:'09:00',end:'12:00',breakMinutes:15,type:'NORMAL',activity:'Natation'}]};
 const sum={expectedMinutes:180,workedMinutes:165,absenceMinutes:0,alreadyPaidMinutes:0,unresolvedRecoveries:0};
 h.c.pCommit_([h.c.pReceipt_(u,sheet,sum)],u,'SUBMIT');u.email='nouvelle@example.test';h.c.pDeliverMail_();
 assert.equal(h.sent.length,2);assert.ok(h.sent.every(m=>m.to==='nouvelle@example.test'));
 const receipt=h.sent.find(m=>m.subject.startsWith('Fiche de prestation reçue'));
 assert.match(receipt.body,/2 h 45/);assert.match(receipt.body,/2026-11-02/);assert.match(receipt.body,/pause 15 min/);assert.match(receipt.body,/ne vaut pas validation/);
});

test('chaque nouvelle version soumise reçoit son accusé, mais la même version ne se renvoie pas',()=>{
 const h=harness(),u=h.addMonitor(),sheet={id:'s',monitorId:u.monitorId,month:'2026-10',revision:2,submissionCount:1,lines:[]},sum={};
 h.c.pCommit_([h.c.pReceipt_(u,sheet,sum)],u,'SUBMIT');h.c.pDeliverMail_();h.c.pCommit_([h.c.pReceipt_(u,sheet,sum)],u,'RETRY');h.c.pDeliverMail_();assert.equal(h.sent.length,1);
 h.c.pCommit_([h.c.pReceipt_(u,{...sheet,revision:5,submissionCount:2},sum)],u,'RESUBMIT');h.c.pDeliverMail_();assert.equal(h.sent.length,2);assert.match(h.sent[1].body,/Version envoyée : 2/);
});

test('les notifications de direction connues suivent le compte actif et les invitations ne changent pas de destinataire',()=>{
 const h=harness();h.users.push({id:'jl',email:'jl@example.test',active:true,uid:'jluid',role:'DIRECTOR'});h.queue();h.users[0].email='jl-nouveau@example.test';h.c.pDeliverMail_();assert.equal(h.sent[0].to,'jl-nouveau@example.test');
 const h2=harness(),u=h2.addMonitor();h2.c.pCommit_([h2.c.pQueueMail_('invite:'+u.id+':1',u.email,'Invitation','Lien privé')],director,'INVITE');u.email='changed@example.test';h2.c.pDeliverMail_();assert.equal(h2.sent.length,0);assert.equal(h2.data[0].status,'CANCELLED');
});

test('rappels désactivés ou hors fenêtre : aucun ajout dans la boîte d’envoi',()=>{
 const h=harness();h.addMonitor();assert.equal(h.c.pPrepareReminders_().outsideWindow,true);h.setNow('2026-11-22T08:00:00Z');h.props.APP_EMAIL_ENABLED='false';assert.equal(h.c.pPrepareReminders_().disabled,true);assert.equal(h.data.length,0);
});

function legacyReminder(h,user,scheduledOn='2026-11-25',extra={}){
 const message={id:'reminder:'+user.monitorId+':2026-11:'+scheduledOn,to:user.email,userId:user.id,monitorId:user.monitorId,kind:'REMINDER',month:'2026-11',scheduledOn,expiresOn:'2026-12-05',status:'PENDING',attempts:0,revision:1,subject:'Ancien rappel',text:'Ancienne échéance au 5.',...extra};
 h.data.push(message);return message;
}
test('anciens rappels annulés même hors jalon, sans quota, ou avec prochaine tentative future',()=>{
 for(const handler of ['pPrepareReminders_','pDeliverMail_']){
  const h=harness(),u=h.addMonitor();h.setNow('2026-11-24T08:00:00Z');h.setQuota(0);
  legacyReminder(h,u,'2026-11-25',{nextAttemptAt:'2026-12-01T08:00:00Z'});
  const result=h.c[handler]();assert.equal(result.cancelled,1);assert.equal(h.data[0].status,'CANCELLED');assert.equal(h.data[0].text,'');assert.equal(h.sent.length,0);
  assert.equal(h.c[handler]().cancelled,0);
 }
});
test('migration sur un jalon commun : ancien rappel en attente annulé, nouveau calendrier appliqué une seule fois',()=>{
 const h=harness(),u=h.addMonitor();h.setNow('2026-11-28T08:00:00Z');legacyReminder(h,u,'2026-11-28');
 const result=h.c.pPrepareReminders_();assert.equal(result.cancelled,1);assert.equal(result.prepared,1);assert.equal(h.data[0].status,'CANCELLED');
 assert.equal(h.c.pPrepareReminders_().prepared,0);h.c.pDeliverMail_();h.c.pDeliverMail_();assert.equal(h.sent.length,1);
 assert.match(h.sent[0].body,/29\/11\/2026/);assert.doesNotMatch(h.sent[0].body,/Ancienne échéance/);
});
test('migration ne double jamais un rappel du même jour envoyé, en cours, incertain ou échoué',()=>{
 for(const status of ['SENT','SENDING','UNKNOWN','FAILED']){
  const h=harness(),u=h.addMonitor();h.setNow('2026-11-28T08:00:00Z');legacyReminder(h,u,'2026-11-28',{status});
  assert.equal(h.c.pPrepareReminders_().prepared,0,status);assert.equal(h.data.length,1,status);assert.equal(h.sent.length,0,status);
 }
});
test('rappel courant bloqué le lendemain même si la préparation quotidienne est arrêtée',()=>{
 const h=harness();h.addMonitor();h.setNow('2026-11-22T08:00:00Z');h.c.pPrepareReminders_();h.setQuota(0);h.c.pDeliverMail_();
 h.setNow('2026-11-22T23:00:00Z');h.setQuota(100);const result=h.c.pDeliverMail_();
 assert.equal(result.cancelled,1);assert.equal(result.pending,0);assert.equal(h.sent.length,0);assert.equal(h.data[0].status,'CANCELLED');
});
test('revalidation avant livraison : association, activation, statut et calendrier contrôlés',()=>{
 for(const mode of ['unactivated','rebound','missing-user','missing-user-id','invalid-schedule','invalid-deadline','invalid-expiry','unknown-status']){
  const h=harness(),u=h.addMonitor();h.setNow('2026-11-22T08:00:00Z');h.c.pPrepareReminders_();
  if(mode==='unactivated')u.uid='';if(mode==='rebound')u.monitorId='someone-else';if(mode==='missing-user')h.users.splice(0);if(mode==='missing-user-id')h.data[0].userId='';
  if(mode==='invalid-schedule')h.data[0].scheduledOn='2026-11-21';if(mode==='invalid-deadline')h.data[0].deadline='2026-12-05';if(mode==='invalid-expiry')h.data[0].expiresOn='2026-12-05';
  if(mode==='unknown-status')h.sheets.push({id:'s',month:'2026-11',monitorId:u.monitorId,status:'ARCHIVED'});
  assert.equal(h.c.pDeliverMail_().cancelled,1,mode);assert.equal(h.sent.length,0,mode);
 }
});
test('renvoi manuel d’un ancien rappel échoué se termine en annulation sans envoi',()=>{
 const h=harness(),u=h.addMonitor();h.setNow('2026-11-28T08:00:00Z');const old=legacyReminder(h,u,'2026-11-28',{status:'FAILED'});
 h.c.pRetryMail_(director,{id:old.id,revision:1,reason:'Échec vérifié'});h.c.pDeliverMail_();
 assert.equal(h.data[0].status,'CANCELLED');assert.equal(h.sent.length,0);
});
test('accusé identifie chaque plage future et sépare les heures prévues des dates déjà écoulées',()=>{
 const h=harness(),u=h.addMonitor();h.setNow('2026-11-22T08:00:00Z');
 const sheet={id:'s',monitorId:u.monitorId,month:'2026-11',revision:2,lines:[{date:'2026-11-21',start:'09:00',end:'10:00',type:'NORMAL'},{date:'2026-11-30',start:'09:00',end:'11:00',type:'NORMAL'},{date:'2026-11-30',start:'11:00',end:'12:00',type:'ABSENCE'}]};
 const mail=h.c.pReceipt_(u,sheet,{expectedMinutes:240,workedMinutes:180,absenceMinutes:60,alreadyPaidMinutes:0,unresolvedRecoveries:0}).record;
 assert.match(mail.text,/dates écoulées : 1 h 00/);assert.match(mail.text,/futures prévisionnelles, non encore effectuées : 2 h 00/);
 assert.match(mail.text,/Plages futures : 2 ; dates : 2026-11-30/);assert.equal(mail.text.split('PRÉVISIONNEL — non encore effectué').length-1,2);assert.match(mail.text,/jusqu’au 5/);
});

test('rappels étendus aux personnes manuelles actives, même cadence sans changer le périmètre piscine',()=>{
 const h=harness();h.setNow('2026-11-22T08:00:00Z');h.addMonitor('pool');h.addMonitor('dance');Object.assign(h.team.find(p=>p.id==='dance'),{sourceMode:'MANUAL'});
 assert.equal(h.c.pTeam_().length,1);assert.equal(h.c.pPrepareReminders_().prepared,2);h.c.pDeliverMail_();assert.equal(h.sent.length,2);
 assert.ok(h.sent.every(mail=>mail.subject.includes('fiche de prestation')&&!mail.subject.includes('piscine')));
 h.setNow('2026-11-26T08:00:00Z');h.c.pPrepareReminders_();h.team.find(p=>p.id==='dance').active=false;h.c.pDeliverMail_();assert.equal(h.sent.length,3);assert.equal(h.data.filter(m=>m.monitorId==='dance'&&m.status==='CANCELLED').length,1);
});
test('accusé manuel ne présente jamais zéro heure prévue comme un planning',()=>{
 const h=harness(),u=h.addMonitor(),sheet={id:'manual',month:'2026-10',monitorId:u.monitorId,revision:2,lines:[]};
 const mail=h.c.pReceipt_(u,sheet,{hasPlanningBaseline:false,workedMinutes:0,absenceMinutes:0}).record;
 assert.match(mail.text,/aucun — saisie manuelle/);assert.doesNotMatch(mail.text,/Heures attendues/);assert.doesNotMatch(mail.text,/prestation piscine/);
});
