/* Identité administrative privée : le NISS ne quitte IDENTITY que lors d'une
 * consultation explicite autorisée ou du préremplissage d'un contrat.
 * Aucun NISS dans USERS, les listes d'équipe, la TV, les emails ou les journaux.
 * Main possède le verrou et vérifie le compte actif avant chaque appel.
 */
function pIdentityStaff_(actor) {
 return !!actor&&actor.active===true&&['DIRECTOR','MANAGER','SECRETARY'].includes(actor.role);
}
function pIdentityFields_(payload,allowed) {
 if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>!allowed.includes(key)))throw Error('Cette demande contient un champ non autorisé.');
}
function pIdentityTarget_(actor,payload) {
 if(!actor||actor.active!==true||!actor.id||!['DIRECTOR','MANAGER','SECRETARY','MONITOR','TECHNICAL'].includes(actor.role))throw Error('Accès à l’identité non autorisé.');
 const id=payload.monitorId===undefined?actor.monitorId:payload.monitorId;
 if(typeof id!=='string'||!id||id.length>160)throw Error('Choisissez une personne.');
 if(!pIdentityStaff_(actor)&&id!==actor.monitorId)throw Error('Vous pouvez consulter uniquement votre propre identité.');
 const matches=pPeople_().filter(person=>person.id===id);
 if(matches.length!==1)throw Error('La fiche de cette personne est absente ou en double.');
 return matches[0];
}
function pIdentityNiss_(value) {
 if(typeof value!=='string'||value.length>32)throw Error('Saisissez le NISS sous forme de 11 chiffres.');
 const normalized=value.trim().replace(/[.\-\s]/g,'');
 // Contrôle de saisie uniquement. Ce contrôle ne certifie pas l'identité
 // et n'invente pas de règle de date ou de statut pour les numéros BIS.
 if(!/^\d{11}$/.test(normalized))throw Error('Le NISS doit comporter exactement 11 chiffres.');
 return normalized;
}
function pIdentityRecord_(monitorId) {
 const record=pGet_('IDENTITY',monitorId);
 if(!record)return null;
 if(record.id!==monitorId||!Number.isSafeInteger(record.revision)||record.revision<1||
    !['PENDING','VERIFIED','REJECTED'].includes(record.status)||
    typeof record.niss!=='string'||record.niss!==''&&!/^\d{11}$/.test(record.niss)||
    record.pending&&(typeof record.pending.niss!=='string'||!/^\d{11}$/.test(record.pending.niss)||record.status!=='PENDING')||
    record.status==='PENDING'&&!record.pending)throw Error('La fiche d’identité privée nécessite une vérification administrative.');
 return record;
}
function pIdentityMasked_(niss) {return niss?'•••••••'+niss.slice(-4):'';}
function pIdentityView_(actor,person,record) {
 const pending=record&&record.pending;
 return {monitorId:person.id,name:person.name,revision:record?record.revision:0,
  status:record?record.status:'MISSING',hasNiss:!!(record&&record.niss),maskedNiss:pIdentityMasked_(record&&record.niss),
  hasPending:!!pending,pendingMaskedNiss:pIdentityMasked_(pending&&pending.niss),
  submittedAt:pending&&pending.submittedAt||record&&record.lastSubmission&&record.lastSubmission.at||'',
  reviewedAt:record&&record.lastReview&&record.lastReview.at||'',
  reviewReason:record&&record.lastReview&&record.lastReview.reason||'',
  canSubmit:person.active===true&&!pending,
  canReview:actor.role==='DIRECTOR'&&!!pending};
}
function pGetIdentity_(actor,payload={}) {
 pIdentityFields_(payload,['monitorId']);
 const person=pIdentityTarget_(actor,payload);
 return pIdentityView_(actor,person,pIdentityRecord_(person.id));
}
function pRevealIdentity_(actor,payload={}) {
 pIdentityFields_(payload,['monitorId']);
 const person=pIdentityTarget_(actor,payload),record=pIdentityRecord_(person.id);
 // Journaliser avant la révélation : aucune valeur, empreinte ou donnée du
 // formulaire n'est inscrite dans AUDIT. Une erreur de journal bloque la lecture.
 pCommit_([{table:'AUDIT',record:{id:pId_(),at:pNow_(),actorId:actor.id,
  action:'CONSULTER_NISS',monitorId:person.id}}],actor,'CONSULTER_IDENTITE');
 return {...pIdentityView_(actor,person,record),niss:record&&record.niss||'',pendingNiss:record&&record.pending&&record.pending.niss||''};
}
function pSubmitIdentity_(actor,payload) {
 pIdentityFields_(payload,['monitorId','niss','revision','requestId']);
 const person=pIdentityTarget_(actor,payload);
 if(person.active!==true)throw Error('Cette personne est inactive. Sa fiche d’identité reste consultable.');
 const niss=pIdentityNiss_(payload.niss),requestId=payload.requestId;
 if(typeof requestId!=='string'||! /^[A-Za-z0-9_-]{16,100}$/.test(requestId))throw Error('Identifiant d’enregistrement requis. Rechargez la fiche.');
 if(!Number.isSafeInteger(payload.revision)||payload.revision<0)throw Error('Version de la fiche requise. Rechargez-la.');
 const current=pIdentityRecord_(person.id),fingerprint=pHash_(['IDENTITY',person.id,actor.id,niss]);
 if(current&&current.lastSubmission&&current.lastSubmission.requestId===requestId){
  if(current.lastSubmission.fingerprint!==fingerprint)throw Error('Cet enregistrement a déjà été utilisé pour une autre demande.');
  return pIdentityView_(actor,person,current);
 }
 if((current?current.revision:0)!==payload.revision)throw Error('La fiche d’identité a changé. Rechargez-la avant de continuer.');
 if(current&&current.pending)throw Error('Une demande attend déjà la validation de la direction.');
 if(current&&current.niss===niss)throw Error('Ce NISS est déjà validé dans votre fiche.');
 const now=pNow_(),record={...(current||{id:person.id,niss:'',createdAt:now}),
  revision:(current?current.revision:0)+1,status:'PENDING',updatedAt:now,
  pending:{niss,requestId,submittedBy:actor.id,submittedAt:now},
  lastSubmission:{requestId,fingerprint,actorId:actor.id,at:now}};
 pCommit_([{table:'IDENTITY',record}],actor,'SOUMETTRE_IDENTITE');
 return pIdentityView_(actor,person,record);
}
function pReviewIdentity_(actor,payload) {
 if(!actor||actor.active!==true||actor.role!=='DIRECTOR')throw Error('La validation du NISS est réservée à la direction.');
 pIdentityFields_(payload,['monitorId','revision','decision','reason']);
 const person=pIdentityTarget_(actor,payload),current=pIdentityRecord_(person.id);
 if(!Number.isSafeInteger(payload.revision)||payload.revision<1)throw Error('Version de la demande requise.');
 if(!['APPROVE','REJECT'].includes(payload.decision)||typeof payload.reason!=='string')throw Error('Décision de validation incorrecte.');
 const reason=payload.reason.trim();
 if(reason.length>500||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(reason)||payload.decision==='REJECT'&&!reason)throw Error('Indiquez un motif de refus, en 500 caractères maximum.');
 if(!current)throw Error('Aucune demande à valider.');
 // Une réponse perdue ne doit ni rejouer une validation ni valider une demande
 // plus récente. Le numéro proposé n'est jamais un paramètre de validation.
 if(current.revision!==payload.revision){
  const previous=current.lastReview;
  if(previous&&previous.sourceRevision===payload.revision&&previous.actorId===actor.id&&previous.decision===payload.decision&&previous.reason===reason)return pIdentityView_(actor,person,current);
  throw Error('La fiche d’identité a changé. Rechargez la demande.');
 }
 if(!current.pending)throw Error('Aucune demande en attente de validation.');
 const now=pNow_(),record={...current,revision:current.revision+1,
  niss:payload.decision==='APPROVE'?current.pending.niss:current.niss,
  status:payload.decision==='APPROVE'?'VERIFIED':'REJECTED',pending:null,updatedAt:now,
  lastReview:{sourceRevision:current.revision,actorId:actor.id,decision:payload.decision,reason,at:now}};
 if(payload.decision==='APPROVE')record.verifiedAt=now;
 pCommit_([{table:'IDENTITY',record}],actor,payload.decision==='APPROVE'?'VALIDER_IDENTITE':'REFUSER_IDENTITE');
 return pIdentityView_(actor,person,record);
}
// Interne uniquement : appelé après l'autorisation administrative du contrat.
// Aucun repli vers une ancienne propriété ou vers la valeur encore en attente.
function pIdentityApprovedNiss_(monitorId) {
 const record=pIdentityRecord_(monitorId);
 return record&&record.niss||'';
}
// Migration appelée uniquement par l'installation autorisée, sous le verrou
// commun. Un ancien NISS mémorisé devient une proposition, jamais une validation.
function pIdentityImportLegacy_(actor,monitorId,value) {
 if(!actor||actor.active!==true||actor.role!=='DIRECTOR')throw Error('Migration de l’identité réservée à la direction.');
 const people=pPeople_().filter(person=>person.id===monitorId);
 if(people.length!==1)return {imported:false,reason:'UNKNOWN_PERSON'};
 if(people[0].active!==true)return {imported:false,reason:'INACTIVE_PERSON'};
 if(pIdentityRecord_(monitorId))return {imported:false,reason:'ALREADY_PRESENT'};
 let niss;try{niss=pIdentityNiss_(value);}catch(ignored){return {imported:false,reason:'INVALID_VALUE'};}
 pSubmitIdentity_(actor,{monitorId,niss,revision:0,requestId:'legacy-niss-'+pHash_(monitorId).slice(0,48)});
 return {imported:true,reason:'PENDING_VALIDATION'};
}
