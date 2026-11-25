/* Boîte d'envoi persistante. Une erreur de mail ne supprime jamais une fiche. */
const P_REMINDER_POLICY_='MONTH_END_V1';
function pQueueMail_(id,to,subject,text,delivery){
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to))throw Error('Destinataire de notification incorrect.');
 const old=pGet_('OUTBOX',id);
 if(old)return {table:'OUTBOX',record:old};
 const options=delivery||{},invitation=String(id).startsWith('invite:');
 // Les invitations contiennent un jeton lié à l'adresse invitée. Les autres
 // messages connus suivent l'identité du compte et son adresse vérifiée courante.
 const matches=invitation?[]:pRows_('USERS').filter(u=>String(u.email||'').toLowerCase()===String(to).toLowerCase()&&u.active===true&&!u.deleted);
 const userId=options.userId||(invitation?String(id).split(':')[1]:(matches.length===1?matches[0].id:''));
 return {table:'OUTBOX',record:{id,to,subject:String(subject).slice(0,180),text:String(text).slice(0,32000),status:'PENDING',attempts:0,revision:1,createdAt:pNow_(),
  kind:invitation?'INVITATION':String(options.kind||'NOTICE'),userId,monitorId:String(options.monitorId||''),month:String(options.month||''),scheduledOn:String(options.scheduledOn||''),expiresOn:String(options.expiresOn||''),deadline:String(options.deadline||''),reminderPolicy:String(options.reminderPolicy||''),sheetId:String(options.sheetId||''),sheetRevision:options.sheetRevision||0}};
}

function pMailDate_(value){
 const text=String(value||'');if(!/^20\d{2}-\d{2}-\d{2}$/.test(text))throw Error('Date de rappel incorrecte.');
 const date=new Date(text+'T00:00:00Z');if(!Number.isFinite(+date)||date.toISOString().slice(0,10)!==text)throw Error('Date de rappel incorrecte.');return date;
}
function pMailReminderWindow_(today){
 pMailDate_(today);const month=today.slice(0,7);
 if(!pReminderDates_(month).includes(today))return null;
 // Exactement J-7, J-3 et J-1 : aucune reprise le lendemain d'un jalon manqué.
 return {month,scheduledOn:today,expiresOn:today,deadline:pDeadline_(month),reminderPolicy:P_REMINDER_POLICY_};
}
function pIsReminder_(message){return message.kind==='REMINDER'||String(message.id||'').startsWith('reminder:');}
function pReminderCancellation_(message,today){
 if(message.reminderPolicy!==P_REMINDER_POLICY_)return 'Ancien calendrier de rappels remplacé.';
 let valid=false;
 try{valid=pReminderDates_(message.month).includes(message.scheduledOn)&&message.deadline===pDeadline_(message.month);}catch(_error){}
 if(!valid||message.expiresOn!==message.scheduledOn)return 'Calendrier de rappel incompatible.';
 if(today!==message.scheduledOn)return 'Jour de rappel dépassé ou non encore atteint.';
 return '';
}
function pCancelPendingReminders_(today){
 const changes=[];
 for(const message of pRows_('OUTBOX').filter(m=>m.status==='PENDING'&&pIsReminder_(m))){
  const reason=pMailRecipient_(message,today).cancel;
  if(reason)changes.push({table:'OUTBOX',record:{...message,status:'CANCELLED',text:'',revision:message.revision+1,cancelReason:reason}});
 }
 if(changes.length)pCommit_(changes,{id:'REMINDER_SERVICE'},'ANNULER_RAPPELS_OBSOLETES');
 return changes.length;
}
function pMailDuration_(minutes){
 const total=Math.max(0,Math.round(Number(minutes)||0));return Math.floor(total/60)+' h '+String(total%60).padStart(2,'0');
}
function pMailOneLine_(text,max){return String(text||'').replace(/[\r\n\t]+/g,' ').slice(0,max||200);}
function pReceipt_(actor,sheet,summary){
 const today=pToday_(),forecast=pForecast_(sheet.lines,today);
 const types={NORMAL:'Prestation habituelle',ABSENCE:'Absence non payée',REMPLACEMENT:'Remplacement',SUPPLEMENT:'Prestation supplémentaire',RATTRAPAGE_COURS:'Rattrapage de cours',RECUPERATION:'Récupération d’heures'};
 const lines=(sheet.lines||[]).map(line=>{
  const duration=pLineMinutes_(line),pause=Number(line.breakMinutes||0);
  return line.date+' | '+line.start+'–'+line.end+(pause?' | pause '+pause+' min':'')+' | '+pMailDuration_(duration)+' | '+(types[line.type]||'Prestation')+' | '+pMailOneLine_(line.activity,100)+(line.date>today?' | PRÉVISIONNEL — non encore effectué':'');
 });
 const text=['Bonjour '+pMailOneLine_(actor.name,100)+',','',
  'Votre fiche de prestation pour '+sheet.month+' a bien été reçue.',
  'Version envoyée : '+String(sheet.submissionCount||1)+'. Cette réception ne vaut pas validation de la direction ni confirmation de paiement.','',
  'RÉCAPITULATIF',
  summary.hasPlanningBaseline===false?'Planning automatique : aucun — saisie manuelle.':'Heures attendues (planning piscine) : '+pMailDuration_(summary.expectedMinutes),
  summary.hasPlanningBaseline!==false&&summary.manualWorkedMinutes?'Autres activités saisies manuellement : '+pMailDuration_(summary.manualWorkedMinutes):'',
  'Total des heures déclarées (effectuées + prévisionnelles) : '+pMailDuration_(summary.workedMinutes),
  'Heures déclarées pour les dates écoulées : '+pMailDuration_(summary.workedMinutes-forecast.workedMinutes),
  'Heures futures prévisionnelles, non encore effectuées : '+pMailDuration_(forecast.workedMinutes),
  forecast.lineCount?'Plages futures : '+forecast.lineCount+' ; dates : '+forecast.dates.join(', ')+'. Absences prévues : '+pMailDuration_(forecast.absenceMinutes)+'.':'',
  'Absences non payées : '+pMailDuration_(summary.absenceMinutes),
  'Récupérations déjà rémunérées identifiées : '+pMailDuration_(summary.alreadyPaidMinutes),
  summary.unresolvedRecoveries?'Certaines récupérations restent à vérifier : leur traitement financier n’est pas encore déterminé.':'Les récupérations déjà rémunérées ne seront pas payées une seconde fois.',
  '', 'DÉTAIL DES PLAGES',...(lines.length?lines:['Aucune plage déclarée.']),
  sheet.declarationNote?'\nVotre commentaire : '+String(sheet.declarationNote).slice(0,2000):'',
  '',forecast.lineCount?'Les heures futures restent prévisionnelles. Corrigez toute différence après les séances, jusqu’au 5 du mois suivant, sauf validation déjà effectuée.':'', 'Vous pouvez retrouver cette version et son statut dans votre espace AtoutSport.', 'L’équipe AtoutSport'].join('\n');
 return pQueueMail_('receipt:'+sheet.id+':'+sheet.revision,actor.email,'Fiche de prestation reçue — '+sheet.month,text,
  {kind:'RECEIPT',userId:actor.id,monitorId:sheet.monitorId,month:sheet.month,sheetId:sheet.id,sheetRevision:sheet.revision});
}
function pMailSheetOpen_(sheets,month,monitorId){
 const matching=sheets.filter(s=>s.month===month&&s.monitorId===monitorId);
 if(matching.length>1)throw Error('Plusieurs fiches existent pour le même moniteur et le même mois.');
 return !matching.length||['DRAFT','RETURNED'].includes(matching[0].status);
}
function pPrepareReminders_(){
 if(pProperties_().getProperty('APP_EMAIL_ENABLED')!=='true')return {prepared:0,disabled:true};
 return pWithLock_(()=>{
  if(pProperties_().getProperty('APP_EMAIL_ENABLED')!=='true')return {prepared:0,disabled:true};
  const today=pToday_(),cancelled=pCancelPendingReminders_(today),window=pMailReminderWindow_(today);if(!window)return {prepared:0,cancelled,outsideWindow:true};
  const eligible=new Set(pPeople_().filter(m=>m.active).map(m=>m.id)),sheets=pRows_('TIMESHEETS'),users=pRows_('USERS'),out=pRows_('OUTBOX'),seen=new Set(),changes=[];
  let prepared=0;
  for(const user of users){
   if(user.active!==true||user.deleted||!user.uid||!user.monitorId||!eligible.has(user.monitorId))continue;
   if(seen.has(user.monitorId))throw Error('Plusieurs accès actifs sont liés à la même personne.');seen.add(user.monitorId);
   if(!pMailSheetOpen_(sheets,window.month,user.monitorId))continue;
   const id='reminder:'+P_REMINDER_POLICY_+':'+user.monitorId+':'+window.month+':'+window.scheduledOn;
   if(out.some(m=>m.id===id))continue;
   // La migration ne renvoie pas un ancien rappel du même jour déjà livré ou incertain.
   if(out.some(m=>pIsReminder_(m)&&m.monitorId===user.monitorId&&m.month===window.month&&m.scheduledOn===window.scheduledOn&&['SENT','SENDING','UNKNOWN','FAILED'].includes(m.status)))continue;
   const text=['Bonjour '+pMailOneLine_(user.name,100)+',','',
    'Votre fiche de prestation pour '+window.month+' reste à envoyer ou à renvoyer après correction.',
    'Vérifiez vos heures, absences, remplacements et récupérations. Vous pouvez envoyer la fiche dès maintenant ; les heures futures doivent être confirmées comme prévisionnelles, puis corrigées si nécessaire après les séances.',
    'Échéance d’envoi : '+window.deadline.slice(8,10)+'/'+window.deadline.slice(5,7)+'/'+window.deadline.slice(0,4)+' (avant-dernier jour du mois).',
    'Une fiche déjà envoyée peut encore être corrigée jusqu’au 5 du mois suivant, sauf si elle a été validée.',
    'Vous pouvez enregistrer un brouillon avant l’envoi. Si la fiche a déjà été envoyée, aucun autre rappel ne sera nécessaire.',
    '', 'L’équipe AtoutSport'].join('\n');
   changes.push(pQueueMail_(id,user.email,'Votre fiche de prestation '+window.month+' reste à envoyer',text,
    {kind:'REMINDER',userId:user.id,monitorId:user.monitorId,...window}));prepared++;
  }
  if(changes.length)pCommit_(changes,{id:'REMINDER_SERVICE'},'PREPARER_RAPPELS_PRESTATIONS');
  return {prepared,cancelled,month:window.month,scheduledOn:window.scheduledOn,deadline:window.deadline};
 });
}
function pMailRecipient_(message,today){
 const reminder=pIsReminder_(message);
 if(reminder){const reason=pReminderCancellation_(message,today);if(reason)return {cancel:reason};if(!message.userId)return {cancel:'Compte personnel du rappel introuvable.'};}
 if(!message.userId)return {to:message.to};
 const user=pGet_('USERS',message.userId);
 if(!user||user.active!==true||user.deleted)return {cancel:'Accès du destinataire désactivé ou supprimé.'};
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email||''))return {cancel:'Adresse du compte indisponible.'};
 if(message.kind==='INVITATION'&&String(user.email).toLowerCase()!==String(message.to).toLowerCase())return {cancel:'Invitation liée à une ancienne adresse.'};
 if((reminder||message.kind==='RECEIPT')&&(!user.uid||user.monitorId!==message.monitorId))return {cancel:'Compte personnel non activé ou association modifiée.'};
 if(reminder){
  if(!pPeople_().some(m=>m.id===message.monitorId&&m.active))return {cancel:'Personne hors de l’équipe active.'};
  if(!pMailSheetOpen_(pRows_('TIMESHEETS'),message.month,message.monitorId))return {cancel:'Fiche déjà envoyée ou validée.'};
 }
 // USERS.email ne change qu'après une nouvelle vérification Firebase du même UID.
 return {to:user.email};
}
function pDeliverMail_(){
 if(pProperties_().getProperty('APP_EMAIL_ENABLED')!=='true')return {sent:0,disabled:true};
 return pWithLock_(()=>{
  if(pProperties_().getProperty('APP_EMAIL_ENABLED')!=='true')return {sent:0,disabled:true};
  let sent=0;const actor={id:'MAIL_SERVICE'},now=Date.now(),today=pToday_();
  let cancelled=pCancelPendingReminders_(today);
  // Après interruption au milieu de sendEmail, ne pas renvoyer automatiquement un message potentiellement déjà délivré.
  for(const m of pRows_('OUTBOX').filter(m=>m.status==='SENDING'&&now-new Date(m.sendingAt).getTime()>15*60000))pCommit_([{table:'OUTBOX',record:{...m,status:'UNKNOWN',revision:m.revision+1,error:'Envoi interrompu : vérifier avant nouvelle tentative.'}}],actor,'MAIL_INDETERMINE');
  const pending=pRows_('OUTBOX').filter(m=>m.status==='PENDING'&&(!m.nextAttemptAt||new Date(m.nextAttemptAt).getTime()<=now)).slice(0,10);
  let cancelledInBatch=0;
  for(const m of pending){
   const recipient=pMailRecipient_(m,today);
   if(recipient.cancel){pCommit_([{table:'OUTBOX',record:{...m,status:'CANCELLED',text:'',revision:m.revision+1,cancelReason:recipient.cancel}}],actor,'MAIL_ANNULE');cancelled++;cancelledInBatch++;continue;}
   if(MailApp.getRemainingDailyQuota()<1)break;
   const claimed={...m,to:recipient.to,status:'SENDING',sendingAt:pNow_(),attempts:m.attempts+1,revision:m.revision+1};
   pCommit_([{table:'OUTBOX',record:claimed}],actor,'MAIL_DEBUT');
   try{
    const configuredUrl=pProperties_().getProperty('APP_URL')||'';
    const appUrl=/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(configuredUrl)?configuredUrl:'';
    const body=m.text+(m.text.includes(appUrl)||!appUrl?'':'\n\nOuvrir votre espace : '+appUrl);
    MailApp.sendEmail({to:recipient.to,subject:m.subject,body,name:'AtoutSport — Gestion administrative'});
   }catch(error){
    // Une exception réseau peut survenir après délivrance : signaler plutôt que risquer un doublon silencieux.
    pCommit_([{table:'OUTBOX',record:{...claimed,status:'FAILED',revision:claimed.revision+1,error:'Envoi non confirmé. Vérification puis relance manuelle nécessaire.'}}],actor,'MAIL_ECHEC');continue;
   }
   // Ne pas placer ce commit dans le catch de l'envoi : si son résultat est incertain, conserver SENDING/UNKNOWN.
   pCommit_([{table:'OUTBOX',record:{...claimed,status:'SENT',sentAt:pNow_(),text:'',revision:claimed.revision+1}}],actor,'MAIL_ENVOYE');sent++;
  }
  return {sent,cancelled,pending:pending.length-sent-cancelledInBatch};
 });
}
function pMailLog_(actor){pDirector_(actor);return {rows:pRows_('OUTBOX').slice(-100).map(({text,...safe})=>safe)};}
function pRetryMail_(actor,p){
 pDirector_(actor);const m=pGet_('OUTBOX',p.id);if(!m||m.revision!==p.revision||!['FAILED','UNKNOWN'].includes(m.status))throw Error('Notification non relançable.');
 if(!String(p.reason||'').trim())throw Error('Confirmez la vérification de l’envoi précédent.');
 pCommit_([{table:'OUTBOX',record:{...m,status:'PENDING',error:'',revision:m.revision+1,retryReason:String(p.reason).slice(0,500)}}],actor,'MAIL_RELANCER');return {queued:true};
}
