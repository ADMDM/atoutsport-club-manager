// ===== Storage.gs =====
/* Stockage privé du portail, distinct des tableaux TV et de l'administration v2. */
const P_TABLES_ = ['USERS','TIMESHEETS','RECOVERIES','DOCUMENTS','OUTBOX','AUDIT','HISTORY','IDENTITY'];
var P_CACHE_ = {};
var P_LAYOUT_ = {};
var P_METADATA_ = null;
function pProperties_(){ return PropertiesService.getScriptProperties(); }
function pNow_(){ return new Date().toISOString(); }
function pToday_(){ return Utilities.formatDate(new Date(),'Europe/Brussels','yyyy-MM-dd'); }
function pId_(){ return Utilities.getUuid(); }
function pHash_(value){ return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,typeof value==='object'?JSON.stringify(value):String(value))).replace(/=+$/,''); }
function pBookId_(){const id=pProperties_().getProperty('PORTAL_BOOK_ID');if(!id)throw Error('Installation du portail à terminer.');return id;}
function pBook_(){return SpreadsheetApp.openById(pBookId_());}
// Lire et écrire par la même API : SpreadsheetApp peut conserver une lecture
// obsolète après un batch REST réussi, même après SpreadsheetApp.flush().
function pReadApi_(suffix){
 const response=UrlFetchApp.fetch('https://sheets.googleapis.com/v4/spreadsheets/'+encodeURIComponent(pBookId_())+suffix,{method:'get',headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},muteHttpExceptions:true});
 if(response.getResponseCode()!==200)throw Error('Lecture du stockage impossible. Réessayez avant toute modification.');
 return JSON.parse(response.getContentText());
}
function pSheet_(name){
 if(!P_TABLES_.includes(name))throw Error('Table inconnue.');
 if(!P_METADATA_)P_METADATA_=pReadApi_('?fields='+encodeURIComponent('sheets(properties(sheetId,title,gridProperties(rowCount)))'));
 const sheet=(P_METADATA_.sheets||[]).map(s=>s.properties).find(s=>s&&s.title===name);
 if(!sheet)throw Error('Installation incomplète : '+name);
 return sheet;
}
function pRows_(name){
 if(!P_CACHE_[name]){
  const sheet=pSheet_(name),values=pReadApi_('/values/'+encodeURIComponent("'"+name+"'!A:B")+'?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE').values||[];
  if(JSON.stringify(values[0])!==JSON.stringify(['ID','JSON']))throw Error('Colonnes du portail modifiées : '+name);
  const physical=values.slice(1),seen=new Set();
  const records=physical.filter(r=>r[0]).map(r=>{const o=JSON.parse(r[1]);if(o.id!==String(r[0])||seen.has(o.id))throw Error('Enregistrement incohérent ou identifiant dupliqué.');seen.add(o.id);return o;});
  P_LAYOUT_[name]={sheetId:sheet.sheetId,maxRows:sheet.gridProperties.rowCount,ids:physical.map(r=>r[0]||''),next:values.length};
  P_CACHE_[name]=records;
 }
 return JSON.parse(JSON.stringify(P_CACHE_[name]));
}
function pGet_(name,id){return pRows_(name).find(r=>r.id===id)||null;}
function pWithLock_(fn){const lock=LockService.getScriptLock();if(!lock.tryLock(15000))throw Error('Une opération est en cours. Réessayez dans quelques secondes.');try{P_CACHE_={};P_LAYOUT_={};P_METADATA_=null;return fn();}finally{lock.releaseLock();}}
function pCommit_(changes,actor,action){
 if(!Array.isArray(changes)||!changes.length)return;
 const all=changes.slice();
 for(const c of changes){if(c.table==='TIMESHEETS'){const before=pGet_('TIMESHEETS',c.record.id);if(before)all.push({table:'HISTORY',record:{id:pId_(),sheetId:c.record.id,actorId:actor&&actor.id||'SYSTEM',at:pNow_(),action:String(action),previous:before}});}}
 all.push({table:'AUDIT',record:{id:pId_(),at:pNow_(),actorId:actor&&actor.id||'SYSTEM',action:String(action),changes:changes.map(c=>({table:c.table,id:c.record.id,revision:c.record.revision||0}))}});
 const requests=[],tables={};
 for(const c of all){
  if(!P_TABLES_.includes(c.table)||!c.record||!c.record.id)throw Error('Écriture invalide.');
  const text=JSON.stringify(c.record);if(text.length>45000)throw Error('Fiche trop volumineuse. Réduisez les commentaires ou le nombre de lignes.');
  const key=String(c.record.id);if(!/^[\w:.-]{1,160}$/.test(key))throw Error('Identifiant invalide.');
  if(!tables[c.table]){const records=pRows_(c.table),layout=P_LAYOUT_[c.table];tables[c.table]={...layout,ids:layout.ids.slice(),records,seen:new Set()};}
  const t=tables[c.table];if(t.seen.has(key))throw Error('Écriture dupliquée dans la transaction.');t.seen.add(key);
  const at=t.ids.indexOf(key),row=at<0?t.next++:at+1;
  requests.push({updateCells:{range:{sheetId:t.sheetId,startRowIndex:row,endRowIndex:row+1,startColumnIndex:0,endColumnIndex:2},rows:[{values:[{userEnteredValue:{stringValue:key}},{userEnteredValue:{stringValue:text}}]}],fields:'userEnteredValue'}});
  t.ids[row-1]=key;
  const recordAt=t.records.findIndex(r=>r.id===key);if(recordAt<0)t.records.push(JSON.parse(text));else t.records[recordAt]=JSON.parse(text);
 }
 for(const t of Object.values(tables))if(t.next>t.maxRows){const length=t.next-t.maxRows+100;requests.unshift({appendDimension:{sheetId:t.sheetId,dimension:'ROWS',length}});t.maxRows+=length;}
 const response=UrlFetchApp.fetch('https://sheets.googleapis.com/v4/spreadsheets/'+encodeURIComponent(pBookId_())+':batchUpdate',{method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},payload:JSON.stringify({requests}),muteHttpExceptions:true});
 if(response.getResponseCode()!==200)throw Error('Enregistrement impossible. Aucune validation confirmée ; rechargez la fiche avant de réessayer.');
 // Publier le cache seulement après le succès atomique du batch. Les commits
 // suivants gardent les bonnes positions physiques (audit, invitations, mails).
 for(const [name,t] of Object.entries(tables)){
  P_CACHE_[name]=t.records;
  P_LAYOUT_[name]={sheetId:t.sheetId,maxRows:t.maxRows,ids:t.ids,next:t.next};
  pSheet_(name).gridProperties.rowCount=t.maxRows;
 }
}


// ===== Auth.gs =====
/* L'identité est vérifiée par Firebase côté serveur, jamais d'après le navigateur. */
function pFirebaseConfig_(){const p=pProperties_();return {apiKey:p.getProperty('FIREBASE_API_KEY')||'',authDomain:p.getProperty('FIREBASE_AUTH_DOMAIN')||'',projectId:p.getProperty('FIREBASE_PROJECT_ID')||'',appId:p.getProperty('FIREBASE_APP_ID')||''};}
function getPortalConfig(){const firebase=pFirebaseConfig_();return {title:'AtoutSport — Gestion administrative',configured:Object.values(firebase).every(Boolean)&&!!pProperties_().getProperty('PORTAL_BOOK_ID'),firebase,appUrl:pProperties_().getProperty('APP_URL')||''};}
function pVerifiedIdentity_(token){
 if(typeof token!=='string'||token.length<100||token.length>12000)throw Error('Connectez-vous pour continuer.');
 const cfg=pFirebaseConfig_();if(!cfg.apiKey||!cfg.projectId)throw Error('Connexion à configurer.');
 let claims;try{claims=JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(token.split('.')[1])).getDataAsString());}catch(e){throw Error('Connexion invalide. Reconnectez-vous.');}
 const now=Math.floor(Date.now()/1000);
 if(claims.aud!==cfg.projectId||claims.iss!=='https://securetoken.google.com/'+cfg.projectId||!claims.sub||claims.exp<=now||claims.iat>now+60)throw Error('Connexion expirée ou incorrecte.');
 // accounts:lookup effectue la validation du jeton signé par Firebase. Le décodage ci-dessus n'est pas une authentification.
 const response=UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key='+encodeURIComponent(cfg.apiKey),{method:'post',contentType:'application/json',payload:JSON.stringify({idToken:token}),muteHttpExceptions:true});
 if(response.getResponseCode()!==200)throw Error('Connexion expirée. Reconnectez-vous.');
 const data=JSON.parse(response.getContentText()),u=data.users&&data.users[0];
 if(!u||u.localId!==claims.sub||u.disabled||!u.emailVerified||!u.email)throw Error('Vérifiez votre adresse email avant de continuer.');
 // Une réinitialisation du mot de passe / révocation invalide aussi une session
 // dont le JWT n'a pas encore expiré. Comparer l'authentification, pas son rafraîchissement.
 const validSince=Number(u.validSince||0);
 if(!Number.isSafeInteger(claims.auth_time)||claims.auth_time<=0||claims.auth_time>now+60||!Number.isSafeInteger(validSince)||validSince<0||claims.auth_time<validSince)throw Error('Connexion révoquée. Reconnectez-vous avec votre mot de passe.');
 return {uid:u.localId,email:String(u.email).toLowerCase()};
}
function pActor_(identity){
 const users=pRows_('USERS').filter(u=>u.uid===identity.uid&&u.email===identity.email&&u.active===true&&!u.deleted);
 if(users.length!==1)throw Error('Votre accès n’est pas actif. Contactez la direction.');
 return pPublicUser_(users[0]);
}
function pPublicUser_(u){return {id:u.id,email:u.email,name:u.name,role:u.role,monitorId:u.monitorId||'',active:u.active===true,deleted:u.deleted===true,revision:u.revision||1,activated:!!u.uid};}
function pDirector_(actor){if(actor.role!=='DIRECTOR')throw Error('Cette action est réservée à la direction.');}
function pDirectorEmail_(){
 const props=pProperties_(),selected=props.getProperty('DIRECTOR_NOTIFICATION_USER_ID'),owner=props.getProperty('OWNER_ACCOUNT_ID');
 const all=pRows_('USERS').filter(u=>u.role==='DIRECTOR'&&u.active===true&&!u.deleted);
 const directors=selected?all.filter(u=>u.id===selected):all.filter(u=>u.id!==owner);
 if(directors.length!==1||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(directors[0].email||'')))throw Error('Le destinataire de direction doit être configuré sans ambiguïté avant les notifications.');
 return directors[0].email;
}
function pActivate_(identity,payload){
 const token=String(payload.invitationToken||'');if(token.length<40||token.length>200)throw Error('Lien d’invitation incomplet.');
 const matches=pRows_('USERS').filter(u=>u.email===identity.email&&u.active&&!u.deleted);if(matches.length!==1)throw Error('Invitation introuvable pour cette adresse.');
 const u=matches[0];
 if(u.uid&&u.uid===identity.uid&&!u.inviteHash)return pPublicUser_(u);
 if(u.uid&&u.uid!==identity.uid)throw Error('Ce compte est déjà lié à une autre connexion.');
 if(!u.inviteHash||pHash_(token)!==u.inviteHash||new Date(u.inviteExpiresAt)<=new Date())throw Error('Invitation expirée ou déjà utilisée. Demandez une nouvelle invitation.');
 const updated={...u,uid:identity.uid,inviteHash:'',inviteExpiresAt:'',activatedAt:pNow_(),revision:u.revision+1};
 // L'activation lie aussi l'email vérifié à la fiche privée ; une ancienne adresse différente reste un conflit, jamais écrasée.
 if(u.monitorId&&!u.profileSync)updated.profileSync={requestId:'activation-email-'+u.id,fingerprint:pHash_(['EMAIL',identity.email]),kind:'EMAIL',status:'PENDING',before:{Email:''},after:{Email:identity.email},createdAt:pNow_()};
 pCommit_([{table:'USERS',record:updated}],{id:u.id},'ACTIVER_COMPTE');return pPublicUser_(updated);
}
function pUsers_(actor){pDirector_(actor);return {rows:pRows_('USERS').map(pPublicUser_)};}
function pInviteUser_(actor,p){
 pDirector_(actor);const email=String(p.email||'').trim().toLowerCase(),name=String(p.name||'').trim();
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||!name||name.length>100)throw Error('Nom et adresse email valides requis.');
 if(!['MONITOR','MANAGER','SECRETARY'].includes(p.role))throw Error('Rôle non disponible pour cette invitation.');
 if((p.role==='MONITOR'||p.monitorId)&&!pPeople_().some(m=>m.id===p.monitorId&&m.active))throw Error('Sélectionnez une personne active dans l’équipe.');
 const users=pRows_('USERS'),existing=users.find(u=>u.email===email);
 if(users.some(u=>u.id!==existing?.id&&u.pendingEmail&&u.pendingEmail.email===email))throw Error('Cette adresse est réservée par un changement email en attente.');
 if(existing){if(existing.uid||existing.role!==p.role||existing.monitorId!==(p.monitorId||''))throw Error('Ce compte existe déjà. Gérez son accès dans la liste.');}
 if(p.monitorId&&users.some(u=>u.monitorId===p.monitorId&&u.id!==existing?.id&&!u.deleted))throw Error('Ce moniteur possède déjà un compte.');
 const user={id:existing?.id||pId_(),name,email,role:p.role,monitorId:p.monitorId||'',active:true,deleted:false,uid:'',revision:existing?existing.revision+1:1};
 const invitation=pInvitation_(user);pCommit_(invitation.changes,actor,'INVITER_COMPTE');return {user:pPublicUser_(invitation.user),queued:true};
}
function pInvitation_(user){
 const appUrl=pProperties_().getProperty('APP_URL');if(!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(appUrl||''))throw Error('Adresse du portail à configurer avant les invitations.');
 const token=pId_().replace(/-/g,'')+pId_().replace(/-/g,'');
 const u={...user,inviteHash:pHash_(token),inviteExpiresAt:new Date(Date.now()+7*86400000).toISOString()};
 const link=appUrl+'#invite='+encodeURIComponent(token)+'&email='+encodeURIComponent(u.email);
 const mail=pQueueMail_('invite:'+u.id+':'+u.revision,u.email,'Votre accès AtoutSport', 'Bonjour '+u.name+',\n\nVotre espace AtoutSport est prêt. Ouvrez ce lien pour choisir votre mot de passe et vérifier votre adresse email :\n'+link+'\n\nCe lien personnel est valable 7 jours.\nL’équipe AtoutSport');
 const obsolete=pRows_('OUTBOX').filter(m=>m.id.startsWith('invite:'+u.id+':')&&m.id!==mail.record.id&&m.status!=='SENT'&&m.status!=='CANCELLED').map(m=>({table:'OUTBOX',record:{...m,status:'CANCELLED',text:'',revision:m.revision+1}}));
 return {user:u,changes:[{table:'USERS',record:u},mail,...obsolete]};
}
function pChangeUser_(actor,p){
 pDirector_(actor);const u=pGet_('USERS',p.id);if(!u||u.revision!==p.revision)throw Error('La liste des utilisateurs a changé. Rechargez-la.');
 if(u.id===actor.id||u.role==='DIRECTOR')throw Error('Le compte de direction ne peut pas être supprimé ici.');
 if(typeof p.active!=='boolean')throw Error('État du compte requis.');
 const updated={...u,active:p.deleted?false:p.active,deleted:p.deleted===true,revision:u.revision+1,updatedAt:pNow_()};
 if(updated.deleted){updated.inviteHash='';updated.inviteExpiresAt='';}
 pCommit_([{table:'USERS',record:updated}],actor,'MODIFIER_ACCES');return pPublicUser_(updated);
}


// ===== Sources.gs =====
/* Lecture seule de l'administration v2.1. Ce module n'écrit jamais dans la TV. */
// Apps Script réinitialise les variables globales à chaque exécution RPC.
// Ne pas employer CacheService ici : les données privées et les horaires doivent
// être relus à la requête suivante, notamment lors d'une soumission.
var pSourceReadCache_ = Object.create(null);

function pSourceTrue_(value) {
  return value === true || value === 1 || String(value).toUpperCase() === 'TRUE';
}

function pSourceMonth_(month) {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(String(month))) throw new Error('Mois attendu : AAAA-MM.');
  return String(month);
}

function pSourceDate_(date) {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(String(date))) throw new Error('Date incorrecte dans le planning.');
  const value = new Date(date + 'T00:00:00Z');
  if (!Number.isFinite(+value) || value.toISOString().slice(0, 10) !== date) throw new Error('Date incorrecte dans le planning.');
  return value;
}

function pSourceMinute_(value) {
  if (typeof value === 'number' && value >= 0 && value < 1) {
    const result = Math.round(value * 1440);
    if (result < 1440) return result;
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))) throw new Error('Heure incorrecte dans le planning piscine.');
  return Number(String(value).slice(0, 2)) * 60 + Number(String(value).slice(3));
}

function pSourceSpan_(row) {
  const start = pSourceMinute_(row.HeureDebut), end = pSourceMinute_(row.HeureFin);
  if (end <= start) throw new Error('Le portail piscine exige un créneau terminé le même jour, après son début.');
  return [start, end];
}

function pSourceClock_(minute) {
  return String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
}

function pSourceRows_(property, name, requiredHeaders) {
  const bookId = PropertiesService.getScriptProperties().getProperty(property);
  if (!bookId) throw new Error('Connexion aux données administratives à configurer : ' + property + '.');
  const cacheKey = bookId + ':' + name + ':' + requiredHeaders.join(',');
  if (pSourceReadCache_[cacheKey]) return pSourceReadCache_[cacheKey];
  const sheet = SpreadsheetApp.openById(bookId).getSheetByName(name);
  if (!sheet) throw new Error('Onglet source manquant : ' + name + '.');
  const count = sheet.getLastRow(), width = sheet.getLastColumn();
  if (!count || !width) throw new Error('Colonnes source manquantes : ' + name + '.');
  if (count > 20000 || width > 80) throw new Error('La table ' + name + ' nécessite un archivage avant lecture par le portail.');
  const values = sheet.getRange(1, 1, count, width).getValues();
  const headers = values.shift().map(value => String(value).trim());
  if (new Set(headers.filter(Boolean)).size !== headers.filter(Boolean).length || requiredHeaders.some(h => !headers.includes(h))) {
    throw new Error('Colonnes source inattendues : ' + name + '.');
  }
  const result = values.filter(row => row[0] !== '' && row[0] != null).map(row => Object.fromEntries(headers.filter(Boolean).map(h => {
    let value = row[headers.indexOf(h)];
    if (value instanceof Date) value = Utilities.formatDate(value, 'Europe/Brussels', h.startsWith('Heure') ? 'HH:mm' : 'yyyy-MM-dd');
    return [h, value == null ? '' : value];
  })));
  pSourceReadCache_[cacheKey] = result;
  return result;
}

function pPoolRows_() {
  const rows = pSourceRows_('TV_BOOK_ID', 'MONITEURS', ['MoniteurID', 'Nom', 'Prenom', 'Actif']);
  const ids = new Set();
  for (const row of rows) {
    if (!row.MoniteurID || ids.has(String(row.MoniteurID))) throw new Error('Identifiant moniteur manquant ou en double dans la source piscine.');
    ids.add(String(row.MoniteurID));
  }
  // MONITEURS est la liste piscine. EQUIPE_EXTRA ne doit pas élargir ce périmètre.
  return rows.filter(row => !/^MONITEURS?[-_ ]STAGE$/i.test(String(row.Fonction || '')));
}

function pTeam_() {
  return pPoolRows_().map(row => ({
    id: String(row.MoniteurID),
    name: [row.Prenom, row.Nom].filter(Boolean).join(' ').trim() || String(row.NomAffiche || row.MoniteurID),
    active: pSourceTrue_(row.Actif)
  })).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

function pPeopleRows_() {
  const pool = pPoolRows_(), poolIds = new Set(pool.map(row => String(row.MoniteurID)));
  const tv = pSourceRows_('TV_BOOK_ID', 'MONITEURS', ['MoniteurID', 'Nom', 'Prenom', 'Actif']);
  const extra = pSourceRows_('ADMIN_BOOK_ID', 'EQUIPE_EXTRA', ['MoniteurID', 'Nom', 'Prenom', 'Actif']);
  const map = new Map(), extraIds = new Set();
  const sectorsFor = role => ({MONITEUR:['PISCINE','STAGE','EXTRASPORT'],MONITEUR_STAGE:['STAGE'],RESPONSABLE:['PISCINE','STAGE','EXTRASPORT'],EXTRASPORT:['EXTRASPORT'],DANSE:['EXTRASPORT'],GESTION:['ADMINISTRATION'],SECRETARIAT:['ADMINISTRATION']})[role] || [];
  // Projection explicite : aucune coordonnée, pièce d'identité ou donnée salariale
  // ne peut entrer dans la liste partagée, même si les colonnes source évoluent.
  const safe = (row, poolMember, previous) => {
    const role = String(row.Role || row.Fonction || previous && previous.Fonction || '').trim().toUpperCase().replace(/[- ]/g,'_');
    return {MoniteurID:String(row.MoniteurID),Nom:String(row.Nom || previous && previous.Nom || ''),Prenom:String(row.Prenom || previous && previous.Prenom || ''),NomAffiche:String(row.NomAffiche || previous && previous.NomAffiche || ''),Actif:pSourceTrue_(row.Actif),Fonction:role,Activites:String(row.Activites || previous && previous.Activites || ''),sourceMode:poolMember?'POOL':'MANUAL',sectors:poolMember?['PISCINE','STAGE','EXTRASPORT']:sectorsFor(role).filter(s=>s!=='PISCINE')};
  };
  for (const row of extra) {
    const id=String(row.MoniteurID || '');
    if(!id || extraIds.has(id))throw new Error('Identifiant manquant ou en double dans EQUIPE_EXTRA.');
    extraIds.add(id);map.set(id,safe(row,false));
  }
  // Une personne déjà dans MONITEURS conserve son identité et son état piscine.
  // La même identité dans EQUIPE_EXTRA enrichit les activités, sans créer de doublon.
  for(const row of tv){const id=String(row.MoniteurID);map.set(id,safe(row,poolIds.has(id),map.get(id)));}
  return [...map.values()];
}

function pPeople_() {
  return pPeopleRows_().map(row=>({id:row.MoniteurID,name:[row.Prenom,row.Nom].filter(Boolean).join(' ').trim()||row.NomAffiche||row.MoniteurID,active:row.Actif,sourceMode:row.sourceMode,sectors:row.sectors})).sort((a,b)=>a.name.localeCompare(b.name,'fr'));
}

function pSourceMode_(monitorId) {
  const person=pPeople_().find(person=>person.id===String(monitorId));
  if(!person)throw new Error('Personne introuvable dans l’équipe.');
  return person.sourceMode;
}

function pExpected_(month, monitorId) {
  pSourceMonth_(month);
  // Le calcul piscine reste strictement celui qui alimentait déjà les fiches.
  // Les autres activités n'ont aucun planning automatique ni heures inventées.
  const pool=pPoolRows_();
  if(!pool.some(row=>String(row.MoniteurID)===String(monitorId))){
    const person=pPeople_().find(person=>person.id===String(monitorId));
    if(!person)throw new Error('Personne introuvable dans l’équipe.');
    if(!person.active)throw new Error('Cette personne est inactive.');
    return [];
  }
  return pExpectedFrom_({
    monitors: pool,
    weekly: pSourceRows_('TV_BOOK_ID', 'HORAIRES', ['MoniteurID', 'JourSemaine', 'HeureDebut', 'HeureFin', 'Actif']),
    presences: pSourceRows_('TV_BOOK_ID', 'PRESENCES', ['MoniteurID', 'Date', 'HeureDebut', 'HeureFin', 'Present']),
    exceptions: pSourceRows_('TV_BOOK_ID', 'EXCEPTIONS', ['MoniteurID', 'Date', 'Type', 'HeureDebut', 'HeureFin', 'RemplacantID', 'Active'])
  }, month, monitorId);
}

function pSourceSlots_(rows, source, date, owner) {
  const slots = new Map();
  rows.forEach((row, index) => {
    const [start, end] = pSourceSpan_(row);
    const reference = String(row.HoraireID || row.PresenceID || row.ExceptionID || row.ID || index);
    const data = {activity: String(row.Activite || 'Natation'), origin: source + ':' + reference, replacedMonitorId: ''};
    for (let minute = start; minute < end; minute++) {
      if (slots.has(minute)) throw new Error('Chevauchement du planning piscine pour ' + owner + ' le ' + date + '.');
      slots.set(minute, data);
    }
  });
  return slots;
}

function pSourceExceptionSpan_(row) {
  const hasStart = row.HeureDebut !== '' && row.HeureDebut != null;
  const hasEnd = row.HeureFin !== '' && row.HeureFin != null;
  if (hasStart !== hasEnd) throw new Error('Une exception du planning possède une seule heure.');
  return hasStart ? pSourceSpan_(row) : [0, 1440];
}

function pExpectedFrom_(input, month, monitorId) {
  pSourceMonth_(month);
  const monitors = input.monitors || [], ids = new Set(monitors.map(row => String(row.MoniteurID)));
  if (!ids.has(String(monitorId))) throw new Error('Moniteur absent de la liste piscine.');
  if (ids.size !== monitors.length) throw new Error('Identifiants piscine en double.');
  const days = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
  const begin = pSourceDate_(month + '-01');
  const end = new Date(Date.UTC(begin.getUTCFullYear(), begin.getUTCMonth() + 1, 1));
  const results = [];
  const weekly = (input.weekly || []).filter(row => pSourceTrue_(row.Actif));
  weekly.forEach(row => {
    if (!days.includes(row.JourSemaine)) throw new Error('Jour de semaine incorrect dans HORAIRES.');
    if (row.DateDebut) pSourceDate_(row.DateDebut);
    if (row.DateFin) pSourceDate_(row.DateFin);
    if (row.DateDebut && row.DateFin && row.DateFin < row.DateDebut) throw new Error('Période inversée dans HORAIRES.');
  });
  const exceptions = (input.exceptions || []).filter(row => pSourceTrue_(row.Active));
  exceptions.forEach(row => pSourceDate_(row.Date));
  (input.presences || []).forEach(row => pSourceDate_(row.Date));
  for (let instant = +begin; instant < +end; instant += 86400000) {
    const date = new Date(instant).toISOString().slice(0, 10);
    const weekday = days[(new Date(instant).getUTCDay() + 6) % 7];
    const events = exceptions.filter(row => row.Date === date);
    const base = {}, removed = {}, absences = {}, incoming = {}, sourceAssignments = {};
    for (const id of ids) {
      const habitual = weekly.filter(row => String(row.MoniteurID) === id && row.JourSemaine === weekday && (!row.DateDebut || date >= row.DateDebut) && (!row.DateFin || date <= row.DateFin));
      const dated = (input.presences || []).filter(row => String(row.MoniteurID) === id && row.Date === date);
      // Comme v2.1, des présences datées remplacent toute la journée récurrente.
      const present = dated.filter(row => pSourceTrue_(row.Present));
      base[id] = pSourceSlots_(dated.length ? present : habitual, dated.length ? 'PRESENCE' : 'HORAIRE', date, id);
      const modifications = events.filter(row => String(row.MoniteurID) === id && row.Type === 'MODIFICATION');
      if (modifications.length > 1) throw new Error('Plusieurs modifications du même jour pour ' + id + ' : choisir une plage de référence.');
      if (modifications.length) base[id] = pSourceSlots_(modifications, 'MODIFICATION', date, id);
      removed[id] = new Set(); absences[id] = new Set(); incoming[id] = new Map(); sourceAssignments[id] = new Map();
    }
    for (const event of events) {
      const owner = String(event.MoniteurID);
      if (!ids.has(owner)) throw new Error('Exception liée à un moniteur piscine inconnu.');
      if (!['MODIFICATION', 'ABSENCE', 'REMPLACEMENT'].includes(event.Type)) throw new Error('Type d’exception piscine inconnu.');
      if (event.Type === 'MODIFICATION') continue;
      const [start, finish] = pSourceExceptionSpan_(event);
      if (event.Type === 'ABSENCE') {
        for (let minute = start; minute < finish; minute++) {
          absences[owner].add(minute);
          if (base[owner].has(minute)) removed[owner].add(minute);
        }
        continue;
      }
      const target = String(event.RemplacantID);
      if (!ids.has(target) || target === owner) throw new Error('Remplaçant piscine incorrect.');
      let matched = 0;
      for (const [minute, data] of base[owner]) {
        if (minute < start || minute >= finish) continue;
        matched++;
        if (sourceAssignments[owner].has(minute)) throw new Error('Deux remplacements portent sur la même plage le ' + date + '.');
        sourceAssignments[owner].set(minute, target);
        if (incoming[target].has(minute)) throw new Error('Deux remplacements se chevauchent pour ' + target + ' le ' + date + '.');
        incoming[target].set(minute, {
          activity: String(event.Activite || data.activity),
          origin: 'REMPLACEMENT:' + String(event.ExceptionID || event.ID || owner + ':' + target + ':' + start + ':' + finish),
          replacedMonitorId: owner
        });
        removed[owner].add(minute);
      }
      if (!matched) throw new Error('Remplacement sans créneau prévu correspondant le ' + date + '.');
    }
    // Les transferts utilisent base, jamais une plage déjà amputée par une absence.
    // On applique tous les retraits avant les arrivées, indépendamment de l'ordre Sheets.
    const actual = {};
    for (const id of ids) {
      actual[id] = new Map([...base[id]].filter(([minute]) => !removed[id].has(minute)));
      for (const [minute, data] of incoming[id]) {
        if (absences[id].has(minute)) throw new Error('Un moniteur est à la fois absent et remplaçant le ' + date + '.');
        if (actual[id].has(minute)) throw new Error('Le remplacement chevauche une autre prestation pour ' + id + ' le ' + date + '.');
        actual[id].set(minute, data);
      }
    }
    const minutes = [...actual[String(monitorId)].keys()].sort((a, b) => a - b);
    for (let index = 0; index < minutes.length;) {
      const start = minutes[index], data = actual[String(monitorId)].get(start);
      let finish = start + 1;
      index++;
      while (index < minutes.length && minutes[index] === finish) {
        const next = actual[String(monitorId)].get(minutes[index]);
        if (next.origin !== data.origin || next.activity !== data.activity || next.replacedMonitorId !== data.replacedMonitorId) break;
        finish++; index++;
      }
      results.push({id: 'expected:' + date + ':' + monitorId + ':' + start + ':' + finish,
        date, start: pSourceClock_(start), end: pSourceClock_(finish), breakMinutes: 0,
        type: 'NORMAL', activity: data.activity, origin: data.origin,
        sourceRef: data.origin, replacedMonitorId: data.replacedMonitorId});
    }
  }
  return results;
}

function pSourceNumber_(value, min, max, label) {
  if (value === '' || value == null || typeof value === 'boolean') throw new Error(label + ' manquant ou incorrect.');
  const text = String(value).trim();
  if (!/^-?\d+(?:[.,]\d+)?$/.test(text)) throw new Error(label + ' incorrect.');
  const number = Number(text.replace(',', '.'));
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(label + ' incorrect.');
  return number;
}

function pFinanceSource_(month, monitorId) {
  pSourceMonth_(month);
  if (!pPeople_().some(person => person.id === String(monitorId))) throw new Error('Personne introuvable dans l’équipe.');
  return pFinanceFrom_({
    rates: pSourceRows_('ADMIN_BOOK_ID', 'REMUNERATIONS', ['MoniteurID', 'Mois', 'PrixHeure', 'RetenuePct', 'ChargePct', 'CotisationsValidees']),
    payments: pSourceRows_('ADMIN_BOOK_ID', 'PAIEMENTS', ['MoniteurID', 'Mois', 'Montant', 'Active']),
    adjustments: pSourceRows_('ADMIN_BOOK_ID', 'AJUSTEMENTS', ['MoniteurID', 'Date', 'Minutes', 'Active'])
  }, month, monitorId);
}

function pFinanceFrom_(input, month, monitorId) {
  pSourceMonth_(month);
  const profiles = (input.rates || []).filter(row => String(row.MoniteurID) === String(monitorId) && row.Mois === month);
  if (profiles.length > 1) throw new Error('Plusieurs tarifs existent pour ce moniteur et ce mois.');
  const profile = profiles[0] || {}, warnings = [];
  let rate = null, deductionPct = null, chargePct = null;
  if (profile.PrixHeure !== '' && profile.PrixHeure != null) rate = pSourceNumber_(profile.PrixHeure, 0, 1000, 'Tarif horaire');
  else warnings.push('Tarif horaire du mois à renseigner dans la gestion administrative.');
  const contributionsConfirmed = pSourceTrue_(profile.CotisationsValidees);
  if (contributionsConfirmed) {
    deductionPct = pSourceNumber_(profile.RetenuePct, 0, 100, 'Retenue');
    chargePct = pSourceNumber_(profile.ChargePct, 0, 100, 'Charge employeur');
  } else warnings.push('Retenue et charge employeur non confirmées : montant net indisponible.');
  const paidCents = (input.payments || []).filter(row => String(row.MoniteurID) === String(monitorId) && row.Mois === month && pSourceTrue_(row.Active))
    .reduce((total, row) => total + Math.round((pSourceNumber_(row.Montant, 0, 1000000, 'Paiement') + Number.EPSILON) * 100), 0);
  const adjustments = (input.adjustments || []).filter(row => String(row.MoniteurID) === String(monitorId) && String(row.Date).slice(0, 7) === month && pSourceTrue_(row.Active));
  const adjustmentsMinutes = adjustments.reduce((total, row) => {
    pSourceDate_(row.Date);
    const minutes = pSourceNumber_(row.Minutes, -1440, 1440, 'Correction administrative');
    if (!Number.isInteger(minutes)) throw new Error('Correction administrative attendue en minutes entières.');
    return total + minutes;
  }, 0);
  if (adjustments.length) warnings.push('Des corrections manuelles existent dans v2.1. Elles ne sont pas ajoutées aux heures déclarées : rapprochement nécessaire pour éviter un doublon.');
  return {rate, deductionPct, chargePct, contributionsConfirmed, paidCents, adjustmentsMinutes, adjustmentsCount: adjustments.length, warnings};
}


// ===== Identity.gs =====
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


// ===== Profile.gs =====
/* Coordonnées personnelles : écrit uniquement Email/Telephone/Adresse dans EQUIPE_EXTRA.
 * Les noms, photos, rôles, horaires et rémunérations ne sont jamais modifiés ici.
 * Le portail garde une intention durable avant la synchronisation inter-classeurs.
 */
function pProfileUser_(actor) {
 const u=actor&&pGet_('USERS',actor.id);
 if(!u||u.active!==true||u.deleted||!u.uid||u.email!==actor.email)throw Error('Votre accès n’est pas actif. Reconnectez-vous.');
 return u;
}
function pProfileMonitor_(u) {
 if(!u.monitorId||!pPeople_().some(m=>m.id===u.monitorId&&m.active))throw Error('Cette fiche est réservée à une personne active de l’équipe.');
}
function pProfileAllowed_(p,allowed) {
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!allowed.includes(k)))throw Error('Cette modification contient un champ non autorisé.');
}
function pProfileRequestId_(id) {
 if(typeof id!=='string'||! /^[A-Za-z0-9_-]{16,100}$/.test(id))throw Error('Identifiant d’enregistrement requis. Rechargez la page.');
 return id;
}
function pProfileEmail_(email) {
 if(typeof email!=='string')throw Error('Adresse email incorrecte.');
 const value=email.trim().toLowerCase();
 if(value.length>254||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))throw Error('Adresse email incorrecte.');
 return value;
}
function pProfileEmailAvailable_(email,userId) {
 if(pRows_('USERS').some(u=>u.id!==userId&&(u.email===email||u.pendingEmail&&u.pendingEmail.email===email)))throw Error('Cette adresse est déjà utilisée ou réservée par un autre compte.');
}
function pProfileApi_(suffix,body) {
 const book=pProperties_().getProperty('ADMIN_BOOK_ID');
 if(!book)throw Error('La connexion au dossier administratif privé reste à configurer.');
 const options={method:body?'post':'get',headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},muteHttpExceptions:true};
 if(body){options.contentType='application/json';options.payload=JSON.stringify(body);}
 const response=UrlFetchApp.fetch('https://sheets.googleapis.com/v4/spreadsheets/'+encodeURIComponent(book)+suffix,options);
 if(response.getResponseCode()!==200)throw Error('Le dossier administratif privé est momentanément indisponible.');
 return JSON.parse(response.getContentText());
}
function pProfileSource_(monitorId) {
 const metadata=pProfileApi_('?fields='+encodeURIComponent('sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))'));
 const sheet=(metadata.sheets||[]).find(s=>s.properties&&s.properties.title==='EQUIPE_EXTRA');
 if(!sheet)throw Error('La fiche administrative privée est indisponible.');
 const grid=sheet.properties.gridProperties||{},height=Math.min(Number(grid.rowCount)||0,20001),width=Math.min(Number(grid.columnCount)||0,80);
 if(!height||!width)throw Error('Les colonnes du dossier administratif privé sont indisponibles.');
 let column='',remaining=width;while(remaining){remaining--;column=String.fromCharCode(65+remaining%26)+column;remaining=Math.floor(remaining/26);}
 const range="'EQUIPE_EXTRA'!A1:"+column+height;
 const data=pProfileApi_('/values/'+encodeURIComponent(range)+'?valueRenderOption=UNFORMATTED_VALUE');
 const values=data.values||[],headers=(values[0]||[]).map(String);
 if(values.length>20000||headers.length>80||new Set(headers.filter(Boolean)).size!==headers.filter(Boolean).length||['MoniteurID','Email','Telephone','Adresse'].some(k=>!headers.includes(k)))throw Error('La table privée EQUIPE_EXTRA nécessite une vérification par la direction.');
 const matches=values.slice(1).map((row,i)=>({row,rowIndex:i+1})).filter(x=>String(x.row[headers.indexOf('MoniteurID')]||'')===monitorId);
 if(matches.length!==1)throw Error('La fiche privée de ce moniteur est absente ou en double. Contactez la direction.');
 const selected=matches[0],fields={};
 for(const key of ['Email','Telephone','Adresse'])fields[key]=String(selected.row[headers.indexOf(key)]??'');
 return {headers,sheetId:sheet.properties.sheetId,rowIndex:selected.rowIndex,fields,revision:pHash_([monitorId,fields.Email,fields.Telephone,fields.Adresse]),emails:values.slice(1).map(row=>({id:String(row[headers.indexOf('MoniteurID')]||''),email:String(row[headers.indexOf('Email')]||'').trim().toLowerCase()}))};
}
function pProfileWriteSource_(monitorId,operation) {
 const source=pProfileSource_(monitorId),updates=[],conflictFields=[];
 for(const [key,target] of Object.entries(operation.after)) {
  if(!['Email','Telephone','Adresse'].includes(key))throw Error('Champ privé non autorisé.');
  const actual=source.fields[key];
  if(actual!==target&&actual!==operation.before[key])conflictFields.push(key);
  if(actual!==target)updates.push({key,value:target});
 }
 if(updates.some(x=>x.key==='Email')&&source.emails.some(x=>x.id!==monitorId&&x.email===operation.after.Email))conflictFields.push('Email');
 if(conflictFields.length)return {status:'CONFLICT',conflictFields:[...new Set(conflictFields)]};
 if(updates.length){
  const requests=updates.map(x=>({updateCells:{range:{sheetId:source.sheetId,startRowIndex:source.rowIndex,endRowIndex:source.rowIndex+1,startColumnIndex:source.headers.indexOf(x.key),endColumnIndex:source.headers.indexOf(x.key)+1},rows:[{values:[{userEnteredValue:{stringValue:x.value}}]}],fields:'userEnteredValue'}}));
  pProfileApi_(':batchUpdate',{requests});
 }
 // Relecture par REST (pas le cache SpreadsheetApp) après écriture ou reprise.
 const check=pProfileSource_(monitorId);
 const changed=Object.entries(operation.after).filter(([key,value])=>check.fields[key]!==value).map(([key])=>key);
 if(changed.length)return {status:'CONFLICT',conflictFields:changed};
 return {status:'SYNCED'};
}
function pProfileSync_(u) {
 const operation=u.profileSync;
 if(!operation)return u;
 if(operation.status==='CONFLICT'&&operation.kind==='EMAIL'){
  try{if(pProfileSource_(u.monitorId).fields.Email!==operation.after.Email)return u;}catch(ignored){return u;}
 }else if(operation.status!=='PENDING')return u;
 let result;
 try{result=pProfileWriteSource_(u.monitorId,operation);}catch(ignored){return u;}
 const updated={...u,profileSync:{...operation,status:result.status,conflictFields:result.conflictFields||[],checkedAt:pNow_()},revision:u.revision+1};
 try{pCommit_([{table:'USERS',record:updated}],{id:u.id},result.status==='SYNCED'?'SYNCHRONISER_COORDONNEES':'CONFLIT_COORDONNEES');return updated;}
 catch(ignored){return u;} // intention durable : la prochaine lecture reprend sans doublon.
}
function pProfileView_(u) {
 const base={revision:u.revision,monitorId:u.monitorId||'',firstName:'',lastName:'',email:u.email,phone:'',address:'',sourceRevision:'',syncStatus:'SYNCED',syncMessage:'',pendingEmail:u.pendingEmail?{email:u.pendingEmail.email,expiresAt:u.pendingEmail.expiresAt}:null,editable:false};
 if(!u.monitorId)return base;
 pProfileMonitor_(u);
 const person=pPeopleRows_().find(m=>String(m.MoniteurID)===u.monitorId),source=pProfileSource_(u.monitorId);
 base.firstName=String(person&&person.Prenom||'');base.lastName=String(person&&person.Nom||'');base.phone=source.fields.Telephone;base.address=source.fields.Adresse;base.sourceRevision=source.revision;base.editable=true;
 if(u.profileSync){base.syncStatus=u.profileSync.status;if(base.syncStatus==='PENDING'){base.syncMessage='Enregistré dans votre compte. Synchronisation du dossier administratif en attente ; actualisez pour réessayer.';if('Telephone' in u.profileSync.after)base.phone=u.profileSync.after.Telephone;if('Adresse' in u.profileSync.after)base.address=u.profileSync.after.Adresse;}else if(base.syncStatus==='CONFLICT'){base.syncMessage=u.profileSync.kind==='EMAIL'?'Votre email de connexion est confirmé, mais des coordonnées ont été modifiées dans le dossier administratif ('+(u.profileSync.conflictFields||['Email']).map(k=>({Email:'email',Telephone:'téléphone',Adresse:'adresse'})[k]||k).join(', ')+'). Contactez la direction pour rapprocher les valeurs ; vos modifications sont suspendues jusque-là.':'Le dossier administratif a été modifié entre-temps. Les coordonnées actuellement enregistrées sont affichées ; vérifiez-les puis enregistrez à nouveau si nécessaire.';}}
 return base;
}
function pGetProfile_(actor) {return pProfileView_(pProfileSync_(pProfileUser_(actor)));}
function pSaveProfile_(actor,p) {
 pProfileAllowed_(p,['revision','sourceRevision','phone','address','requestId']);
 let u=pProfileUser_(actor);pProfileMonitor_(u);
 const requestId=pProfileRequestId_(p.requestId);
 if(typeof p.phone!=='string'||typeof p.address!=='string')throw Error('Téléphone et adresse attendus.');
 const phone=p.phone.trim(),address=p.address.replace(/\r\n?/g,'\n').trim();
 if(phone.length>50||phone&&! /^[+0-9 ()./-]+$/.test(phone)||address.length>500||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(address))throw Error('Téléphone ou adresse incorrects.');
 const fingerprint=pHash_(['PROFILE',phone,address]);
 if(u.profileSync&&u.profileSync.requestId===requestId){if(u.profileSync.fingerprint!==fingerprint)throw Error('Cet enregistrement a déjà été utilisé pour d’autres coordonnées.');return pProfileView_(pProfileSync_(u));}
 u=pProfileSync_(u);
 if(u.revision!==p.revision)throw Error('Votre fiche a changé. Rechargez vos coordonnées avant de les modifier.');
 if(u.profileSync&&u.profileSync.kind==='EMAIL'&&u.profileSync.status==='CONFLICT')throw Error('Le dossier administratif contient une autre adresse email ou des coordonnées en conflit. Contactez la direction avant de modifier vos coordonnées.');
 if(u.profileSync&&u.profileSync.status==='PENDING')throw Error('La synchronisation précédente doit se terminer avant une nouvelle modification. Actualisez puis réessayez.');
 const source=pProfileSource_(u.monitorId);
 if(source.revision!==p.sourceRevision)throw Error('Les coordonnées administratives ont changé. Rechargez votre fiche.');
 const operation={requestId,fingerprint,kind:'PROFILE',status:'PENDING',before:{Telephone:source.fields.Telephone,Adresse:source.fields.Adresse},after:{Telephone:phone,Adresse:address},createdAt:pNow_()};
 u={...u,profileSync:operation,revision:u.revision+1};
 pCommit_([{table:'USERS',record:u}],actor,'MODIFIER_COORDONNEES');
 return pProfileView_(pProfileSync_(u));
}
function pRequestProfileEmail_(actor,p) {
 pProfileAllowed_(p,['revision','email','requestId']);
 let u=pProfileUser_(actor);pProfileMonitor_(u);
 const requestId=pProfileRequestId_(p.requestId),email=pProfileEmail_(p.email);
 if(u.pendingEmail&&u.pendingEmail.requestId===requestId){if(u.pendingEmail.email!==email)throw Error('Cette demande correspond déjà à une autre adresse.');return pProfileView_(u);}
 u=pProfileSync_(u);
 if(u.revision!==p.revision)throw Error('Votre fiche a changé. Rechargez-la avant de changer d’adresse email.');
 if(email===u.email)throw Error('Cette adresse est déjà votre adresse de connexion.');
 if(u.profileSync&&u.profileSync.status==='PENDING')throw Error('Attendez la synchronisation de vos coordonnées avant de changer d’adresse email.');
 pProfileEmailAvailable_(email,u.id);
 const source=pProfileSource_(u.monitorId);
 if(source.emails.some(x=>x.id!==u.monitorId&&x.email===email))throw Error('Cette adresse figure déjà dans une autre fiche de moniteur.');
 u={...u,pendingEmail:{email,uid:u.uid,requestId,requestedAt:pNow_(),expiresAt:new Date(Date.now()+7*86400000).toISOString(),sourceBefore:source.fields.Email},revision:u.revision+1};
 pCommit_([{table:'USERS',record:u}],actor,'DEMANDER_CHANGEMENT_EMAIL');
 return pProfileView_(u);
}
function pCompleteProfileEmail_(identity,payload) {
 // Seul Main appelle ce helper avec l'identité vérifiée côté Firebase, jamais un acteur issu du navigateur.
 const matches=pRows_('USERS').filter(u=>u.uid===identity.uid&&u.active===true&&!u.deleted);
 if(matches.length!==1)throw Error('Votre accès n’est pas actif. Contactez la direction.');
 let u=matches[0];
 if(u.email===identity.email){u=pProfileSync_(u);return {actor:pPublicUser_(u),completed:false,syncStatus:u.profileSync&&u.profileSync.status||'SYNCED'};}
 const pending=u.pendingEmail;
 if(!pending||pending.uid!==identity.uid||pending.email!==identity.email)throw Error('Ce changement d’adresse n’a pas été demandé depuis ce compte. Contactez la direction.');
 pProfileMonitor_(u);pProfileEmailAvailable_(identity.email,u.id);
 // Même après la période conseillée pour vérifier le lien, le même UID et
 // l'adresse effectivement vérifiée par Firebase permettent de récupérer l'accès.
 // La réservation reste conservée jusqu'à achèvement ou remplacement explicite.
 u=pProfileSync_(u);
 const inFlight=u.profileSync&&u.profileSync.status==='PENDING'?u.profileSync:null;
 const operation={requestId:pending.requestId,fingerprint:pHash_(['EMAIL',identity.email]),kind:'EMAIL',status:'PENDING',before:{...(inFlight?inFlight.before:{}),Email:pending.sourceBefore},after:{...(inFlight?inFlight.after:{}),Email:identity.email},createdAt:pNow_()};
 u={...u,email:identity.email,pendingEmail:null,emailChangedAt:pNow_(),profileSync:operation,revision:u.revision+1};
 pCommit_([{table:'USERS',record:u}],{id:u.id},'CONFIRMER_EMAIL_VERIFIE');
 u=pProfileSync_(u);
 return {actor:pPublicUser_(u),completed:true,syncStatus:u.profileSync&&u.profileSync.status||'SYNCED'};
}


// ===== Domain.gs =====
/* Règles pures du portail piscine. Durées en minutes, montants en centimes. */
const P_TYPES_ = ['NORMAL','ABSENCE','REMPLACEMENT','SUPPLEMENT','RATTRAPAGE_COURS','RECUPERATION'];
const P_REVIEW_ROLES_ = ['DIRECTOR','MANAGER','SECRETARY'];
const P_ACTIVITIES_ = ['Natation','Bébés nageurs','Aquagym','Aquafit','Multisports','Éveil sportif','Psychomotricité','Cyclomotricité','Tennis','VTT','Danse','Danse / Hip-hop','Cuisine','Équitation','Sciences','Garderie','Mini-foot','Zumba kids','Jogging','Zumba','Body Balance','Coaching','Gestion administrative','Comptabilité','Direction','Secrétariat'];
function pActivities_(){return P_ACTIVITIES_.slice();}
function pPoolActivities_(expected){return [...new Set(['Natation','Bébés nageurs','Aquagym','Aquafit',...(expected||[]).map(line=>String(line.activity||'Natation'))])];}
function pBaselineLines_(lines,expected,sourceMode){if(sourceMode==='MANUAL')return [];const activities=new Set(pPoolActivities_(expected));return (lines||[]).filter(line=>activities.has(line.activity||'Natation'));}

function pMonthValue_(value) {
  const month=String(value||'');
  if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month))throw new Error('Choisissez un mois valide.');
  return month;
}
function pDateValue_(value) {
  const text=String(value||'');
  if(!/^20\d{2}-\d{2}-\d{2}$/.test(text))throw new Error('Date incorrecte.');
  const date=new Date(text+'T00:00:00Z');
  if(!Number.isFinite(+date)||date.toISOString().slice(0,10)!==text)throw new Error('Date incorrecte.');
  return text;
}
function pTextValue_(value,max,label) {
  const text=String(value==null?'':value).trim();
  if(text.length>max)throw new Error((label||'Texte')+' trop long.');
  return text;
}
function pNumberValue_(value,min,max,label) {
  if(value===''||value==null||typeof value==='boolean')throw new Error((label||'Nombre')+' manquant.');
  const number=Number(value);
  if(!Number.isFinite(number)||number<min||number>max)throw new Error((label||'Nombre')+' incorrect.');
  return number;
}
function pClockValue_(value) {
  const text=String(value||'');
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(text))throw new Error('Heure incorrecte : format HH:MM attendu.');
  return Number(text.slice(0,2))*60+Number(text.slice(3));
}
function pLineMinutes_(line) {
  return pClockValue_(line.end)-pClockValue_(line.start)-Number(line.breakMinutes||0);
}
function pNormalizeLines_(input,month,monitorId,team,allowedActivities) {
  pMonthValue_(month);
  if(!Array.isArray(input)||input.length>120)throw new Error('Une fiche peut contenir au maximum 120 plages.');
  const seen=new Set(),known=new Set((team||[]).map(m=>m.id));
  const result=input.map(raw=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Ligne incorrecte.');
    const id=pTextValue_(raw.id||pId_(),100,'Identifiant');
    if(!/^[A-Za-z0-9_-]+$/.test(id)||seen.has(id))throw new Error('Identifiant de ligne incorrect ou dupliqué.');
    seen.add(id);
    const date=pDateValue_(raw.date);
    if(date.slice(0,7)!==month)throw new Error('Toutes les prestations doivent appartenir au mois choisi.');
    const start=String(raw.start||''),end=String(raw.end||''),from=pClockValue_(start),to=pClockValue_(end);
    if(to<=from)throw new Error('La fin doit être après le début, le même jour.');
    const pause=pNumberValue_(raw.breakMinutes==null?0:raw.breakMinutes,0,to-from-1,'Pause');
    if(!Number.isInteger(pause))throw new Error('La pause est exprimée en minutes entières.');
    const type=String(raw.type||'NORMAL');
    if(!P_TYPES_.includes(type))throw new Error('Type de prestation inconnu.');
    const sourceRef=pTextValue_(raw.sourceRef,300,'Origine'),recoveryId=pTextValue_(raw.recoveryId,100,'Crédit de récupération');
    let replacedMonitorId='';
    if(type==='REMPLACEMENT'){
      replacedMonitorId=String(raw.replacedMonitorId||'');
      if(!known.has(replacedMonitorId)||replacedMonitorId===monitorId)throw new Error('Choisissez la personne remplacée.');
      if(!sourceRef)throw new Error('Précisez la séance ou le créneau remplacé.');
    }
    if(['RECUPERATION','RATTRAPAGE_COURS'].includes(type)&&!sourceRef)throw new Error('Précisez l’origine des heures récupérées ou du cours rattrapé.');
    if(type==='ABSENCE'&&pause!==0)throw new Error('Une absence doit être saisie sans pause ; séparez les plages si nécessaire.');
    const activity=pTextValue_(raw.activity||'Natation',100,'Activité');
    if(allowedActivities&&!allowedActivities.includes(activity))throw new Error('Choisissez une activité proposée.');
    return {id,date,start,end,breakMinutes:pause,type,activity,replacedMonitorId,sourceRef,recoveryId:['RECUPERATION','RATTRAPAGE_COURS'].includes(type)?recoveryId:'',note:pTextValue_(raw.note,1000,'Commentaire')};
  });
  result.sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start)||a.id.localeCompare(b.id));
  for(let i=1;i<result.length;i++){
    if(result[i].date===result[i-1].date&&pClockValue_(result[i].start)<pClockValue_(result[i-1].end))throw new Error('Deux plages se chevauchent le '+result[i].date+'. Séparez les heures travaillées et les absences.');
  }
  return result;
}
function pRecoveryUsage_(sheets,excludeId) {
  const used={};
  for(const sheet of sheets||[]){
    if(sheet.status!=='APPROVED'||sheet.id===excludeId)continue;
    for(const line of sheet.lines||[])if(['RECUPERATION','RATTRAPAGE_COURS'].includes(line.type)&&line.recoveryId)used[line.recoveryId]=(used[line.recoveryId]||0)+pLineMinutes_(line);
  }
  return used;
}
function pSummarize_(lines,expected,credits,sheets,sheetId,monitorId,sourceMode) {
  const mode=sourceMode||'POOL',baseline=new Set(pBaselineLines_(lines,expected,mode));
  const byDay={},warnings=[],creditMap=new Map((credits||[]).map(r=>[r.id,r])),used=pRecoveryUsage_(sheets,sheetId),claims={};
  let worked=0,absent=0,alreadyPaid=0,unresolved=0,expectedTotal=0;
  const day=d=>byDay[d]||(byDay[d]={date:d,expectedMinutes:0,workedMinutes:0,poolWorkedMinutes:0,manualWorkedMinutes:0,absenceMinutes:0,alreadyPaidMinutes:0,payableMinutes:0,differenceMinutes:0});
  const minuteSets={};
  for(const line of expected||[]){
    const d=pDateValue_(line.date),a=pClockValue_(line.start),b=pClockValue_(line.end),pause=Number(line.breakMinutes||0);
    if(b<=a||pause!==0)throw new Error('Planning source non exploitable : vérifiez les plages et pauses.');
    const set=minuteSets[d]||(minuteSets[d]=new Set());for(let i=a;i<b;i++)set.add(i);
  }
  for(const date of Object.keys(minuteSets)){const n=minuteSets[date].size;day(date).expectedMinutes=n;expectedTotal+=n;}
  for(const line of lines||[]){
    const n=pLineMinutes_(line),d=day(line.date);
    if(line.type==='ABSENCE'){absent+=n;d.absenceMinutes+=n;continue;}
    worked+=n;d.workedMinutes+=n;
    if(baseline.has(line))d.poolWorkedMinutes+=n;else d.manualWorkedMinutes+=n;
    if(['RECUPERATION','RATTRAPAGE_COURS'].includes(line.type)){
      const credit=creditMap.get(line.recoveryId);
      if(!credit||credit.monitorId!==monitorId){unresolved++;warnings.push('Récupération du '+line.date+' : origine et paiement à confirmer par la direction.');continue;}
      if(pDateValue_(credit.date)>line.date){unresolved++;warnings.push('Récupération du '+line.date+' antérieure à son origine.');continue;}
      claims[credit.id]=(claims[credit.id]||0)+n;
      if(credit.paidBefore===true){alreadyPaid+=n;d.alreadyPaidMinutes+=n;}
    }
  }
  for(const id of Object.keys(claims))if((used[id]||0)+claims[id]>creditMap.get(id).minutes){unresolved++;warnings.push('Le crédit de récupération '+id+' est insuffisant ou déjà utilisé.');}
  const rows=Object.values(byDay).sort((a,b)=>a.date.localeCompare(b.date));
  for(const d of rows){d.payableMinutes=d.workedMinutes-d.alreadyPaidMinutes;d.differenceMinutes=mode==='MANUAL'?null:d.poolWorkedMinutes-d.expectedMinutes;if(mode==='MANUAL')d.expectedMinutes=null;}
  const poolWorked=rows.reduce((sum,d)=>sum+d.poolWorkedMinutes,0),manualWorked=rows.reduce((sum,d)=>sum+d.manualWorkedMinutes,0);
  return {sourceMode:mode,hasPlanningBaseline:mode!=='MANUAL',workedMinutes:worked,poolWorkedMinutes:poolWorked,manualWorkedMinutes:manualWorked,absenceMinutes:absent,alreadyPaidMinutes:alreadyPaid,payableMinutes:worked-alreadyPaid,expectedMinutes:mode==='MANUAL'?null:expectedTotal,differenceMinutes:mode==='MANUAL'?null:poolWorked-expectedTotal,byDate:rows,warnings:[...new Set(warnings)],unresolvedRecoveries:unresolved};
}
function pCalculateFinance_(summary,source) {
  source=source||{};
  const warnings=[...(source.warnings||[])],paid=Number(source.paidCents||0);
  if(!Number.isSafeInteger(paid)||paid<0)throw new Error('Paiements source incohérents.');
  let rate=null,gross=null,due=null,cost=null;
  if(source.rate!==null&&source.rate!==undefined&&source.rate!=='')rate=pNumberValue_(source.rate,0,1000,'Tarif horaire');
  else warnings.push('Tarif horaire à compléter dans la gestion administrative.');
  if(summary.unresolvedRecoveries)warnings.push('Montant à calculer après vérification des récupérations.');
  else if(rate!==null){
    gross=Math.round(summary.payableMinutes*rate*100/60);
    if(source.contributionsConfirmed===true){
      const deduction=pNumberValue_(source.deductionPct,0,100,'Retenue'),charge=pNumberValue_(source.chargePct,0,100,'Charge employeur');
      due=gross-Math.round(gross*deduction/100);cost=gross+Math.round(gross*charge/100);
    }else warnings.push('Retenues et charges à confirmer dans la gestion administrative.');
  }
  if(Number(source.adjustmentsMinutes||0)!==0)warnings.push('Des corrections existent dans l’ancien décompte : elles ne sont pas additionnées une deuxième fois à cette déclaration.');
  return {rate,grossCents:gross,dueCents:due,paidCents:paid,balanceCents:due===null?null:due-paid,employerCostCents:cost,warnings:[...new Set(warnings)]};
}
function pDeadline_(month) {
  pMonthValue_(month);const d=new Date(month+'-01T00:00:00Z');
  // Calcul calendaire indépendant de l'heure d'été ; le jour courant est celui de Bruxelles.
  return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,-1)).toISOString().slice(0,10);
}
function pCorrectionDeadline_(month) {
  pMonthValue_(month);const d=new Date(month+'-01T00:00:00Z');
  return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,5)).toISOString().slice(0,10);
}
function pReminderDates_(month) {
  const deadline=new Date(pDeadline_(month)+'T00:00:00Z');
  return [7,3,1].map(days=>new Date(+deadline-days*86400000).toISOString().slice(0,10));
}
function pForecast_(lines,today) {
  pDateValue_(today);
  const future=(lines||[]).filter(line=>pDateValue_(line.date)>today);
  return {lineCount:future.length,workedMinutes:future.filter(l=>l.type!=='ABSENCE').reduce((sum,line)=>sum+pLineMinutes_(line),0),absenceMinutes:future.filter(l=>l.type==='ABSENCE').reduce((sum,line)=>sum+pLineMinutes_(line),0),dates:[...new Set(future.map(line=>line.date))].sort()};
}


// ===== Timesheets.gs =====
/* Parcours de déclaration ; les mutations sont verrouillées par portalRpc. */
function pReviewer_(actor) {return actor&&P_REVIEW_ROLES_.includes(actor.role);}
function pRequireDirector_(actor) {if(!actor||actor.role!=='DIRECTOR')throw new Error('Cette action est réservée à la direction.');}
function pTargetMonitor_(actor,payload,ownOnly) {
  const id=String(payload.monitorId||actor.monitorId||'');
  if(!id||(!pReviewer_(actor)||ownOnly)&&id!==actor.monitorId)throw new Error('Accès à cette fiche non autorisé.');
  const person=pPeople_().find(m=>m.id===id);
  if(!person)throw new Error('Personne introuvable dans l’équipe.');
  if(ownOnly&&!person.active)throw new Error('Cette personne est inactive.');
  return id;
}
function pSheetContext_(sheet,month,monitorId) {
  const sourceMode=sheet?(sheet.sourceMode||'POOL'):pSourceMode_(monitorId);
  if(!['POOL','MANUAL'].includes(sourceMode))throw new Error('Mode de fiche inconnu. Contactez le support.');
  let expected=sheet&&sheet.expectedSnapshot;
  if(!expected){
    if(sourceMode==='MANUAL')expected=[];
    else {
      if(pSourceMode_(monitorId)!=='POOL')throw new Error('Cette ancienne fiche piscine nécessite un rapprochement par la direction.');
      expected=pExpected_(month,monitorId);
    }
  }
  if(sourceMode==='MANUAL'&&expected.length)throw new Error('Une fiche manuelle ne peut pas contenir de planning piscine.');
  return {sourceMode,expected,activities:[...new Set([...pActivities_(),...expected.map(line=>String(line.activity||'Natation'))])],poolBaselineActivities:sourceMode==='POOL'?pPoolActivities_(expected):[]};
}
function pNormalizeSheetLines_(input,month,monitorId,context) {
  if(!Array.isArray(input))throw new Error('Les prestations doivent être une liste de plages.');
  if(context.sourceMode==='MANUAL'&&input.some(line=>!line||!String(line.activity||'').trim()))throw new Error('Choisissez une activité pour chaque plage.');
  return pNormalizeLines_(input,month,monitorId,pPeople_(),context.activities);
}
function pFindSheet_(month,monitorId) {
  const found=pRows_('TIMESHEETS').filter(s=>s.month===month&&s.monitorId===monitorId);
  if(found.length>1)throw new Error('Plusieurs fiches existent pour ce mois. Contactez le support.');
  return found[0]||null;
}
function pReadSheet_(actor,id) {
  const sheet=pGet_('TIMESHEETS',String(id||''));
  if(!sheet||!pReviewer_(actor)&&sheet.monitorId!==actor.monitorId)throw new Error('Fiche introuvable ou non autorisée.');
  return sheet;
}
function pCheckRevision_(record,revision) {
  if(!Number.isSafeInteger(revision)||revision!==(record?record.revision:0))throw new Error('La fiche a changé. Rechargez-la avant de continuer.');
}
function pHasSubmission_(sheet) {return Boolean(sheet&&(sheet.firstSubmittedAt||sheet.submittedAt||Number(sheet.submissionCount)>0));}
function pCanEditSheet_(actor,sheet) {
  if(!actor||sheet.monitorId!==actor.monitorId||sheet.status==='APPROVED'||!pPeople_().some(person=>person.id===sheet.monitorId&&person.active))return false;
  if(sheet.status==='RETURNED')return true;
  if(sheet.status==='SUBMITTED'||sheet.status==='DRAFT'&&pHasSubmission_(sheet))return pToday_()<=pCorrectionDeadline_(sheet.month);
  return sheet.status==='DRAFT';
}
function pCanSubmitSheet_(actor,sheet,expected,today) {
  if(!['DRAFT','RETURNED'].includes(sheet.status)||!pCanEditSheet_(actor,sheet)||sheet.month>today.slice(0,7))return false;
  if(!(sheet.lines||[]).concat(expected||[]).some(line=>line.date>today))return true;
  return sheet.month===today.slice(0,7)&&today>=pReminderDates_(sheet.month)[0];
}
function pDeclarationDifferences_(lines,expected) {
  const groups=(rows,planned)=>{
    const grouped={};
    for(const line of rows){
      if(line.type==='ABSENCE')continue;
      const type=planned&&(line.replacedMonitorId||String(line.origin||'').startsWith('REMPLACEMENT:'))?'REMPLACEMENT':String(line.type||'NORMAL');
      const date=String(line.date),item=JSON.stringify([String(line.start),String(line.end),Number(line.breakMinutes||0),String(line.activity||'Natation'),type,type==='REMPLACEMENT'?String(line.replacedMonitorId||''):'']);
      (grouped[date]||(grouped[date]=[])).push(item);
    }
    for(const date of Object.keys(grouped))grouped[date].sort();
    return grouped;
  };
  const actual=groups(lines,false),planned=groups(expected,true);
  return [...new Set([...Object.keys(actual),...Object.keys(planned)])].filter(date=>JSON.stringify(actual[date]||[])!==JSON.stringify(planned[date]||[])).sort();
}
function pCheckDeclarationReason_(sheet,lines,expected,sourceMode) {
  const differences=sourceMode==='MANUAL'?[]:pDeclarationDifferences_(pBaselineLines_(lines,expected,sourceMode),expected),note=pTextValue_(sheet.declarationNote,2000,'Justification');
  const unexplained=differences.filter(date=>!lines.some(line=>line.date===date&&String(line.note||'').trim()));
  if(differences.length&&!note&&unexplained.length)throw new Error('Expliquez les changements par rapport au planning dans la justification générale ou dans les commentaires des journées concernées : '+unexplained.join(', ')+'.');
  return {differences,note};
}
function pViewMonth_(actor,month,monitorId) {
  const stored=pFindSheet_(month,monitorId),sheet=stored||{id:monitorId+'__'+month,monitorId,month,status:'DRAFT',revision:0,lines:[],comment:'',declarationNote:'',submittedAt:'',validatedAt:'',expectedSnapshot:null};
  const context=pSheetContext_(stored,month,monitorId),expected=context.expected,sourceMode=context.sourceMode,credits=pRows_('RECOVERIES'),all=pRows_('TIMESHEETS');
  const summary=pSummarize_(sheet.lines,expected,credits,all,sheet.id,monitorId,sourceMode),today=pToday_(),forecast=pForecast_(sheet.lines,today);
  summary.forecastMinutes=forecast.workedMinutes;summary.performedMinutes=summary.workedMinutes-forecast.workedMinutes;
  let finance=null;
  if(pReviewer_(actor)){
    const current=pFinanceSource_(month,monitorId),source=sheet.financeSnapshot?{...sheet.financeSnapshot,paidCents:current.paidCents}:current;
    finance=pCalculateFinance_(summary,source);
    finance.provisional=sheet.status!=='APPROVED';
    if(finance.provisional){
      finance.estimatedGrossCents=finance.grossCents;finance.estimatedDueCents=finance.dueCents;
      finance.grossCents=null;finance.dueCents=null;finance.balanceCents=null;
      finance.warnings.push('Fiche non validée : aucun montant définitif à payer.');
    }
  }
  const safeSheet={...sheet,sourceMode,poolBaselineActivities:context.poolBaselineActivities};delete safeSheet.financeSnapshot;
  return {sheet:safeSheet,today,sourceMode,hasPlanningBaseline:sourceMode==='POOL',activities:context.activities,exists:Boolean(stored),expected,summary,finance,forecast,hasForecast:forecast.lineCount>0,submissionOpensOn:pReminderDates_(month)[0],canSubmit:pCanSubmitSheet_(actor,sheet,expected,today),canApprove:actor.role==='DIRECTOR'&&sheet.status==='SUBMITTED'&&month<today.slice(0,7),canEdit:pCanEditSheet_(actor,sheet),canCorrectSubmission:sheet.status==='SUBMITTED'&&pCanEditSheet_(actor,sheet),canReturn:pReviewer_(actor)&&(sheet.status==='SUBMITTED'||sheet.status==='DRAFT'&&pHasSubmission_(sheet)),requiresResubmission:sheet.status==='DRAFT'&&pHasSubmission_(sheet),deadline:pDeadline_(month),correctionDeadline:pCorrectionDeadline_(month),reminderDates:pReminderDates_(month),late:today>pDeadline_(month)&&['DRAFT','RETURNED'].includes(sheet.status),changedDates:sourceMode==='MANUAL'?[]:pDeclarationDifferences_(pBaselineLines_(sheet.lines,expected,sourceMode),expected)};
}
function pMonth_(actor,payload) {
  const month=pMonthValue_(payload.month),monitorId=pTargetMonitor_(actor,payload,false);
  return pViewMonth_(actor,month,monitorId);
}
function pSaveDraft_(actor,payload) {
  const month=pMonthValue_(payload.month),monitorId=pTargetMonitor_(actor,payload,true),before=pFindSheet_(month,monitorId);
  pCheckRevision_(before,payload.revision);
  if(before&&!pCanEditSheet_(actor,before))throw new Error(before.status==='APPROVED'?'Cette fiche est validée. Une réouverture par la direction est nécessaire.':'Cette fiche a déjà été envoyée et le délai de correction du 5 est dépassé. Demandez une réouverture à un responsable.');
  const context=pSheetContext_(before,month,monitorId),lines=pNormalizeSheetLines_(payload.lines,month,monitorId,context);
  const declarationNote=pTextValue_(payload.declarationNote===undefined?before&&before.declarationNote:payload.declarationNote,2000,'Justification');
  const correcting=before&&before.status==='SUBMITTED';
  const record={...(before||{}),id:before?before.id:monitorId+'__'+month,monitorId,month,sourceMode:context.sourceMode,poolBaselineActivities:context.poolBaselineActivities,status:correcting?'DRAFT':before?before.status:'DRAFT',revision:(before?before.revision:0)+1,lines,declarationNote,comment:before?before.comment||'':'',updatedAt:pNow_(),updatedBy:actor.id,createdAt:before?before.createdAt:pNow_(),submittedAt:before?before.submittedAt||'':'',firstSubmittedAt:before?before.firstSubmittedAt||before.submittedAt||'':'',validatedAt:'',expectedSnapshot:before?before.expectedSnapshot||null:null};
  if(correcting){record.correctedAfterSubmissionAt=pNow_();record.financeSnapshot=null;record.validationSummary=null;}
  pCommit_([{table:'TIMESHEETS',record}],actor,correcting?'CORRIGER_FICHE_ENVOYEE':'ENREGISTRER_BROUILLON');
  return pViewMonth_(actor,month,monitorId);
}
function pSubmit_(actor,payload) {
  const before=pReadSheet_(actor,payload.sheetId);
  if(before.monitorId!==actor.monitorId)throw new Error('Seul le moniteur peut envoyer sa fiche.');
  // Réessayer le même clic ne renvoie pas un second email.
  if(before.status==='SUBMITTED'&&before.submittedFromRevision===payload.revision)return pViewMonth_(actor,before.month,before.monitorId);
  pCheckRevision_(before,payload.revision);
  if(!['DRAFT','RETURNED'].includes(before.status))throw new Error('Fiche déjà envoyée ou validée.');
  if(!pCanEditSheet_(actor,before))throw new Error('Le délai de correction du 5 est dépassé. Un responsable doit demander une correction pour rouvrir la fiche.');
  const today=pToday_();
  if(before.month>today.slice(0,7))throw new Error('Vous ne pouvez pas envoyer une fiche pour un mois futur.');
  const context=pSheetContext_(before,before.month,before.monitorId),lines=pNormalizeSheetLines_(before.lines,before.month,before.monitorId,context);
  const expected=context.expected,forecast=pForecast_(lines,today);
  if(!pCanSubmitSheet_(actor,{...before,lines},expected,today))throw new Error('Les prestations futures restent prévisionnelles. Leur envoi est possible à partir du '+pReminderDates_(before.month)[0]+' (premier rappel), avec confirmation explicite.');
  if(forecast.lineCount&&payload.forecastAcknowledged!==true)throw new Error('Confirmez que les heures futures sont prévisionnelles et devront être corrigées si elles changent, jusqu’au 5 du mois suivant.');
  const justification=pCheckDeclarationReason_(before,lines,expected,context.sourceMode),again=pHasSubmission_(before);
  const record={...before,sourceMode:context.sourceMode,poolBaselineActivities:context.poolBaselineActivities,lines,declarationNote:justification.note,changedDates:justification.differences,status:'SUBMITTED',revision:before.revision+1,submittedFromRevision:before.revision,submittedAt:pNow_(),submittedLate:today>pDeadline_(before.month),forecastAtSubmission:forecast,forecastAcknowledgedAt:forecast.lineCount?pNow_():'',firstSubmittedAt:before.firstSubmittedAt||before.submittedAt||pNow_(),submissionCount:Math.max(Number(before.submissionCount||0),again?1:0)+1,expectedSnapshot:expected,expectedRevision:pHash_(expected),updatedAt:pNow_(),updatedBy:actor.id,validatedAt:'',financeSnapshot:null};
  const appUrl=String(pProperties_().getProperty('APP_URL')||'');
  const link=/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(appUrl)?'\n\nOuvrir le portail : '+appUrl:'';
  const forecastNotice=forecast.lineCount?'\n\nPRÉVISIONNEL : '+forecast.lineCount+' plage(s) future(s), dont '+forecast.workedMinutes+' minutes de travail prévu et '+forecast.absenceMinutes+' minutes d’absence prévue. Ces heures ne sont pas encore effectuées. Dates : '+forecast.dates.join(', ')+'. Validation finale uniquement après la fin du mois.':'';
  const mail=pQueueMail_('sheet-'+record.id+'-'+record.revision,pDirectorEmail_(),(again?'Fiche corrigée à vérifier — ':'Fiche de prestation à vérifier — ')+before.month,actor.name+(again?' a envoyé une nouvelle version de sa fiche':' a envoyé sa fiche')+' de prestation pour '+before.month+'. Retrouvez-la dans le portail AtoutSport.'+forecastNotice+link);
  const summary=pSummarize_(lines,expected,pRows_('RECOVERIES'),pRows_('TIMESHEETS'),record.id,record.monitorId,context.sourceMode);
  const receipt=pReceipt_(actor,record,summary);
  pCommit_([{table:'TIMESHEETS',record},mail,receipt],actor,again?'RENVOYER_FICHE_CORRIGEE':'ENVOYER_FICHE');
  return pViewMonth_(actor,record.month,record.monitorId);
}
function pDashboard_(actor,payload) {
  if(!pReviewer_(actor))throw new Error('Accès réservé aux responsables.');
  const month=pMonthValue_(payload.month),today=pToday_();
  const rows=pPeople_().map(m=>{
    const view=pViewMonth_(actor,month,m.id),s=view.sheet,sum=view.summary,f=view.finance;
    // Le suivi porte sur l’activité du mois, pas sur toute la liste des personnes.
    // Un remplaçant sans horaire habituel reste visible, même marqué inactif.
    const replacementExpected=view.expected.some(line=>(line.replacedMonitorId||String(line.origin||'').startsWith('REMPLACEMENT:'))&&pLineMinutes_(line)>0);
    if(!(sum.workedMinutes>0||m.active&&sum.expectedMinutes>0||replacementExpected))return null;
    return {monitorId:m.id,name:m.name,sourceMode:view.sourceMode,hasPlanningBaseline:view.hasPlanningBaseline,poolWorkedMinutes:sum.poolWorkedMinutes,manualWorkedMinutes:sum.manualWorkedMinutes,status:view.exists?s.status:'MISSING',sheetId:s.id,revision:s.revision,workedMinutes:sum.workedMinutes,performedMinutes:sum.performedMinutes,forecastMinutes:sum.forecastMinutes,forecast:view.forecast,hasForecast:view.hasForecast,expectedMinutes:sum.expectedMinutes,differenceMinutes:sum.differenceMinutes,late:today>pDeadline_(month)&&['DRAFT','RETURNED'].includes(s.status),dueCents:f.dueCents,paidCents:f.paidCents,balanceCents:f.balanceCents,warnings:[...sum.warnings,...f.warnings],active:m.active};
  }).filter(Boolean);
  return {rows,month,deadline:pDeadline_(month),correctionDeadline:pCorrectionDeadline_(month),reminderDates:pReminderDates_(month)};
}
function pCheckReplacementConflicts_(sheet,all) {
  for(const line of sheet.lines.filter(l=>l.type==='REMPLACEMENT')){
    const start=pClockValue_(line.start),end=pClockValue_(line.end);
    for(const other of all.filter(s=>s.status==='APPROVED'&&s.id!==sheet.id))for(const l of other.lines||[]){
      if(l.date!==line.date||pClockValue_(l.start)>=end||pClockValue_(l.end)<=start)continue;
      if(l.type==='REMPLACEMENT'&&l.replacedMonitorId===line.replacedMonitorId)throw new Error('Ce remplacement chevauche un remplacement déjà validé.');
      if(other.monitorId===line.replacedMonitorId&&l.type!=='ABSENCE')throw new Error('La personne remplacée a déjà une prestation validée sur ce créneau. Vérifiez les deux fiches.');
    }
  }
  // La même protection vaut si la fiche du remplacé est validée en second.
  for(const other of all.filter(s=>s.status==='APPROVED'&&s.id!==sheet.id))for(const l of other.lines||[]){
    if(l.type!=='REMPLACEMENT'||l.replacedMonitorId!==sheet.monitorId)continue;
    if(sheet.lines.some(line=>line.type!=='ABSENCE'&&line.date===l.date&&pClockValue_(line.start)<pClockValue_(l.end)&&pClockValue_(line.end)>pClockValue_(l.start)))throw new Error('Un autre moniteur a déjà un remplacement validé sur ce créneau.');
  }
}
function pReview_(actor,payload) {
  const decision=String(payload.decision||'');
  if(decision==='CORRECT')return pCorrectSheetByDirector_(actor,payload);
  if(decision==='RETURN'){if(!pReviewer_(actor))throw new Error('Accès réservé aux responsables.');}else pRequireDirector_(actor);
  if(!['RETURN','APPROVE','REOPEN'].includes(decision))throw new Error('Décision inconnue.');
  const before=pReadSheet_(actor,payload.sheetId);pCheckRevision_(before,payload.revision);
  const comment=pTextValue_(payload.comment,2000,'Commentaire'),all=pRows_('TIMESHEETS'),credits=pRows_('RECOVERIES');
  if(decision==='REOPEN'){
    if(before.status!=='APPROVED'||!comment)throw new Error('Une fiche validée et un motif de réouverture sont requis.');
    const dependent=new Set(credits.filter(r=>r.sourceSheetId===before.id||r.sourceRef==='sheet:'+before.id).map(r=>r.id));
    if(all.some(s=>s.status==='APPROVED'&&s.id!==before.id&&(s.lines||[]).some(l=>dependent.has(l.recoveryId))))throw new Error('Une récupération liée à cette fiche est déjà validée ailleurs. Rouvrez d’abord la fiche qui l’utilise.');
  }else if(before.status!=='SUBMITTED'&&!(decision==='RETURN'&&before.status==='DRAFT'&&pHasSubmission_(before)))throw new Error('Seule une fiche envoyée peut être contrôlée.');
  let record={...before,revision:before.revision+1,comment,updatedAt:pNow_(),updatedBy:actor.id};
  if(decision==='APPROVE'){
    if(before.month>=pToday_().slice(0,7))throw new Error('La validation finale est possible après la fin du mois.');
    const context=pSheetContext_(before,before.month,before.monitorId);
    pNormalizeSheetLines_(before.lines,before.month,before.monitorId,context);
    const summary=pSummarize_(before.lines,context.expected,credits,all,before.id,before.monitorId,context.sourceMode);
    if(summary.unresolvedRecoveries)throw new Error('Associez chaque récupération à une origine vérifiée et un crédit disponible.');
    if(summary.hasPlanningBaseline&&summary.byDate.some(d=>d.differenceMinutes!==0)&&!comment)throw new Error('Expliquez les écarts avec le planning avant validation.');
    pCheckReplacementConflicts_(before,all);
    const financeSource=pFinanceSource_(before.month,before.monitorId);
    if((Number(financeSource.adjustmentsCount||0)>0||Number(financeSource.adjustmentsMinutes||0)!==0||(financeSource.warnings||[]).some(w=>/corrections manuelles/i.test(w)))&&!comment)throw new Error('Expliquez le rapprochement avec les corrections de l’ancien décompte avant validation.');
    pCalculateFinance_(summary,financeSource);
    record={...record,status:'APPROVED',validatedAt:pNow_(),validatedBy:actor.id,financeSnapshot:financeSource,validationSummary:summary};
  }else{
    if(!comment)throw new Error('Un commentaire est requis pour demander une correction.');
    record={...record,status:'RETURNED',validatedAt:'',validatedBy:'',financeSnapshot:null,validationSummary:null};
  }
  pCommit_([{table:'TIMESHEETS',record}],actor,'FICHE_'+decision);
  return pViewMonth_(actor,record.month,record.monitorId);
}
function pRecoveries_(actor,payload) {
  const requested=payload.monitorId?String(payload.monitorId):'';
  if(!pReviewer_(actor)&&requested&&requested!==actor.monitorId)throw new Error('Accès non autorisé.');
  const monitorId=pReviewer_(actor)?requested:actor.monitorId;
  if(!pReviewer_(actor)&&!monitorId)throw new Error('Aucun moniteur associé.');
  const used=pRecoveryUsage_(pRows_('TIMESHEETS'));
  return {rows:pRows_('RECOVERIES').filter(r=>!monitorId||r.monitorId===monitorId).map(r=>({...r,usedMinutes:used[r.id]||0,remainingMinutes:r.minutes-(used[r.id]||0)}))};
}
function pSaveRecovery_(actor,payload) {
  pRequireDirector_(actor);const raw=payload.record||{};
  if(raw.id)throw new Error('Un crédit existant ne peut pas être modifié.');
  const monitorId=pTargetMonitor_(actor,{monitorId:raw.monitorId},false),date=pDateValue_(raw.date),minutes=pNumberValue_(raw.minutes,1,14400,'Crédit en minutes');
  if(!Number.isInteger(minutes))throw new Error('Le crédit doit être exprimé en minutes entières.');
  if(date>pToday_())throw new Error('L’origine ne peut pas être dans le futur.');
  if(typeof raw.paidBefore!=='boolean')throw new Error('Précisez si ces heures ont déjà été rémunérées.');
  const sourceRef=pTextValue_(raw.sourceRef,300,'Référence d’origine'),note=pTextValue_(raw.note,1000,'Justification');
  if(!sourceRef||!note)throw new Error('La référence d’origine et sa justification sont obligatoires.');
  const sourceSheetId=pTextValue_(raw.sourceSheetId,100,'Fiche d’origine');
  if(sourceSheetId){const source=pGet_('TIMESHEETS',sourceSheetId);if(!source||source.monitorId!==monitorId||source.status!=='APPROVED')throw new Error('La fiche d’origine doit être validée pour ce moniteur.');}
  if(pRows_('RECOVERIES').some(r=>r.monitorId===monitorId&&r.sourceRef.toLowerCase()===sourceRef.toLowerCase()))throw new Error('Cette origine possède déjà un crédit.');
  const record={id:pId_(),monitorId,date,minutes,paidBefore:raw.paidBefore,sourceRef,note,sourceSheetId,revision:1,createdAt:pNow_(),createdBy:actor.id};
  pCommit_([{table:'RECOVERIES',record}],actor,'CREER_CREDIT_RECUPERATION');
  return record;
}
function pAssignRecovery_(actor,payload) {
  pRequireDirector_(actor);const before=pReadSheet_(actor,payload.sheetId);pCheckRevision_(before,payload.revision);
  if(before.status!=='SUBMITTED')throw new Error('La fiche doit être envoyée avant le contrôle des récupérations.');
  const line=before.lines.find(l=>l.id===payload.lineId),credit=pGet_('RECOVERIES',String(payload.recoveryId||''));
  if(!line||!['RECUPERATION','RATTRAPAGE_COURS'].includes(line.type)||!credit||credit.monitorId!==before.monitorId)throw new Error('Récupération ou crédit incorrect.');
  if(credit.date>line.date)throw new Error('La récupération ne peut pas précéder son origine.');
  const record={...before,lines:before.lines.map(l=>l.id===line.id?{...l,recoveryId:credit.id}:l),revision:before.revision+1,updatedAt:pNow_(),updatedBy:actor.id};
  const context=pSheetContext_(record,record.month,record.monitorId);
  const summary=pSummarize_(record.lines,context.expected,pRows_('RECOVERIES'),pRows_('TIMESHEETS'),record.id,record.monitorId,context.sourceMode);
  if(summary.warnings.some(w=>w.includes('insuffisant ou déjà utilisé')))throw new Error('Le crédit est insuffisant ou déjà utilisé.');
  pCommit_([{table:'TIMESHEETS',record}],actor,'ASSOCIER_RECUPERATION');
  return pViewMonth_(actor,record.month,record.monitorId);
}


// ===== Documents.gs =====
/* Documents privés : aucune URL Drive n'est transmise au navigateur. */
const P_DOCUMENT_LIMIT_ = 6 * 1024 * 1024;
const P_DOCUMENT_MIMES_ = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx'
};

function pDocStaff_(actor) {
  return !!actor && actor.active === true && ['DIRECTOR', 'MANAGER', 'SECRETARY'].includes(actor.role);
}

function pDocActor_(actor) {
  if (!actor || actor.active !== true || !actor.id ||
      !['DIRECTOR', 'MANAGER', 'SECRETARY', 'TECHNICAL', 'MONITOR'].includes(actor.role)) {
    throw new Error('Accès aux documents non autorisé.');
  }
}

function pDocText_(value, maximum, required) {
  const s = String(value == null ? '' : value).normalize('NFC').trim();
  if ((required && !s) || s.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) {
    throw new Error('Informations du document incorrectes.');
  }
  return s;
}

function pDocCanRead_(actor, document) {
  if (!document) return false;
  if (pDocStaff_(actor)) return true;
  if (document.visibility === 'PRIVATE') return !!actor.monitorId && document.monitorId === actor.monitorId;
  return document.visibility === 'POOL' && !!actor.monitorId && document.status !== 'ARCHIVED' &&
    pTeam_().some(person => person.id === actor.monitorId && person.active === true);
}

function pDocPublic_(document) {
  return {
    id: document.id,
    monitorId: document.monitorId || '',
    title: document.title,
    category: document.category,
    visibility: document.visibility,
    status: document.status,
    createdAt: document.createdAt || '',
    revision: document.revision,
    contractRef: document.contractRef || '',
    filename: document.filename || '',
    mime: document.mime || '',
    size: document.size || 0,
    contractStatus: document.contractStatus || '',
    signedDate: document.signedDate || '',
    sentDate: document.sentDate || '',
    legacy: !!document.legacy,
    readOnly: !!document.legacy
  };
}

function pLegacyDocumentRows_() {
  const id = pProperties_().getProperty('ADMIN_BOOK_ID');
  if (!id) return [];
  const sheet = SpreadsheetApp.openById(id).getSheetByName('DOCUMENTS');
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  const headers = values.shift();
  for (const key of ['DocumentID', 'MoniteurID', 'Titre', 'Type', 'FichierID', 'Active']) {
    if (!headers.includes(key)) throw new Error('Les colonnes des documents administratifs ont changé.');
  }
  const props = pProperties_(), rows = values.filter(row => row[0]).map(values => {
    const row = Object.fromEntries(headers.map((key, index) => [key, values[index]]));
    let state = {};
    if (row.Type === 'CONTRAT') {
      const raw = props.getProperty('CONTRACT_STATUS_' + row.DocumentID);
      if (raw) {
        try { state = JSON.parse(raw); if (!state || typeof state !== 'object' || Array.isArray(state)) state = {status: 'UNKNOWN'}; }
        catch (ignored) { state = {status: 'UNKNOWN'}; }
      }
      else state = {status: String(row.Titre || '').startsWith('Brouillon') ? 'BROUILLON' : 'NON_SIGNE'};
    }
    const active = row.Active === true || String(row.Active).toUpperCase() === 'TRUE';
    return {
      id: 'legacy:' + row.DocumentID, monitorId: String(row.MoniteurID || ''),
      title: String(row.Titre || 'Document existant'), category: String(row.Type || 'AUTRE'),
      visibility: 'PRIVATE', status: active ? 'AVAILABLE' : 'ARCHIVED',
      contractStatus: state.status || '', signedDate: String(state.signedDate || ''), sentDate: String(state.sentDate || ''),
      originalId: String(state.originalId || ''),
      dateDocument: row.DateDocument instanceof Date ? Utilities.formatDate(row.DateDocument, 'Europe/Brussels', 'yyyy-MM-dd') : String(row.DateDocument || ''),
      dateEnd: row.DateFin instanceof Date ? Utilities.formatDate(row.DateFin, 'Europe/Brussels', 'yyyy-MM-dd') : String(row.DateFin || ''),
      createdAt: row.CreeLe instanceof Date ? row.CreeLe.toISOString() : String(row.CreeLe || ''),
      fileId: String(row.FichierID || ''), revision: 0, contractRef: '', legacy: true
    };
  });
  // La version signée reste un fichier distinct ; elle référence l'original sans le recopier.
  for (const signed of rows.filter(row => row.originalId && row.contractStatus === 'SIGNE' && row.status !== 'ARCHIVED')) {
    const original = rows.find(row => row.id === 'legacy:' + signed.originalId && row.monitorId === signed.monitorId && row.category === 'CONTRAT');
    if (original) { original.contractStatus = 'SIGNE'; original.signedDate = signed.signedDate; }
  }
  for (const row of rows) if (row.category === 'CONTRAT' && row.status !== 'ARCHIVED') {
    row.status = {BROUILLON: 'DRAFT', NON_SIGNE: 'AWAITING_SIGNATURE', SIGNE: 'SIGNED'}[row.contractStatus] || 'TO_REVIEW';
  }
  return rows;
}

function pDocResolve_(id) {
  if (typeof id !== 'string' || !id || id.length > 180) throw new Error('Document introuvable.');
  return id.startsWith('legacy:')
    ? pLegacyDocumentRows_().find(row => row.id === id) || null
    : pGet_('DOCUMENTS', id);
}

function pDocuments_(actor) {
  pDocActor_(actor);
  const rows = pRows_('DOCUMENTS').concat(pLegacyDocumentRows_());
  return {rows: rows.filter(row => pDocCanRead_(actor, row))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .map(pDocPublic_)};
}

// Projection du même catalogue dans l'administration embarquée. Aucun fichier ni identifiant Drive copié.
function pDocumentsAdminList_(actor, legacyList) {
  if (!pDocStaff_(actor)) throw new Error('Administration réservée aux responsables.');
  const rows = pRows_('DOCUMENTS').concat(pLegacyDocumentRows_()).filter(row => pDocCanRead_(actor, row));
  return {headers: ['DocumentID','MoniteurID','Titre','Type','DateDocument','DateFin','Active','CreeLe'],
    revision: legacyList.revision, rows: rows.map(row => ({
      DocumentID: row.legacy ? row.id.slice(7) : 'portal:' + row.id,
      MoniteurID: row.monitorId || '', Titre: row.title, Type: row.category,
      DateDocument: row.dateDocument || '', DateFin: row.dateEnd || '', Active: row.status !== 'ARCHIVED',
      CreeLe: row.createdAt || '', StatutDocument: row.status, StatutSignature: row.contractStatus || '',
      Visibilite: row.visibility, PortalRevision: row.legacy ? null : row.revision,
      CanArchive: !!row.legacy || actor.role === 'DIRECTOR' || row.visibility !== 'PRIVATE'
    })).sort((a,b) => String(b.CreeLe).localeCompare(String(a.CreeLe)))};
}

function pDocArchivePortal_(actor, payload) {
  pDocActor_(actor);
  const p = payload || {}, document = pGet_('DOCUMENTS', String(p.id || ''));
  if (!document || !pDocStaff_(actor) || !pDocCanRead_(actor, document)) throw new Error('Document introuvable ou accès non autorisé.');
  if (actor.role !== 'DIRECTOR' && document.visibility === 'PRIVATE') throw new Error('Cette décision est réservée à la direction.');
  if (!Number.isInteger(p.revision) || document.revision !== p.revision) throw new Error('Le document a changé. Actualisez la liste.');
  if (typeof p.active !== 'boolean') throw new Error('Classement du document incorrect.');
  if ((document.status !== 'ARCHIVED') === p.active) return pDocPublic_(document);
  const next = {...document, status: p.active ? document.preArchiveStatus || 'TO_REVIEW' : 'ARCHIVED',
    preArchiveStatus: p.active ? '' : document.status, revision: document.revision + 1,
    reviewedAt: pNow_(), reviewedBy: actor.id};
  pCommit_([{table:'DOCUMENTS',record:next}],actor,p.active?'DOCUMENT_RESTORED':'DOCUMENT_ARCHIVED');
  return pDocPublic_(next);
}

function pDocFilename_(name, mime) {
  const extension = P_DOCUMENT_MIMES_[mime];
  if (!extension) throw new Error('Format accepté : PDF, JPEG, PNG ou DOCX.');
  let base = String(name || 'document').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f\/\\:*?"<>|\u202a-\u202e\u2066-\u2069]/g, '_')
    .replace(/\.[^.]*$/, '').replace(/^\.+|[. ]+$/g, '').trim().slice(0, 110);
  if (!base) base = 'document';
  return base + extension;
}

function pDocZipCheck_(bytes) {
  // Inspecte le répertoire ZIP sans décompresser son contenu (évite une expansion mémoire non bornée).
  const length = bytes.length, u16 = i => bytes[i] | bytes[i + 1] << 8;
  const u32 = i => (bytes[i] | bytes[i + 1] << 8 | bytes[i + 2] << 16 | bytes[i + 3] << 24) >>> 0;
  let end = -1;
  for (let i = length - 22; i >= Math.max(0, length - 65557); i--) {
    if (u32(i) === 0x06054b50 && i + 22 + u16(i + 20) === length) { end = i; break; }
  }
  if (end < 0 || u16(end + 4) !== 0 || u16(end + 6) !== 0) throw new Error('Document DOCX invalide.');
  const count = u16(end + 10), start = u32(end + 16), size = u32(end + 12);
  if (!count || count > 2500 || count !== u16(end + 8) || start + size !== end) throw new Error('Document DOCX invalide.');
  let position = start, expanded = 0;
  const names = new Set();
  for (let i = 0; i < count; i++) {
    if (position + 46 > end || u32(position) !== 0x02014b50 || (u16(position + 8) & 1)) throw new Error('Document DOCX chiffré ou invalide.');
    const nameLength = u16(position + 28), extraLength = u16(position + 30), commentLength = u16(position + 32);
    const next = position + 46 + nameLength + extraLength + commentLength;
    if (next > end || !nameLength) throw new Error('Document DOCX invalide.');
    const name = bytes.slice(position + 46, position + 46 + nameLength).map(value => String.fromCharCode(value)).join('');
    if (name.startsWith('/') || name.includes('..') || name.includes('\\') || /vbaProject\.bin$/i.test(name)) throw new Error('Document DOCX non accepté.');
    expanded += u32(position + 24);
    if (expanded > 50 * 1024 * 1024) throw new Error('Le document DOCX décompressé est trop volumineux.');
    names.add(name); position = next;
  }
  if (position !== end || !names.has('[Content_Types].xml') || !names.has('word/document.xml')) throw new Error('Ce fichier n’est pas un document DOCX.');
}

function pDocCheckBytes_(rawBytes, mime) {
  const begins = prefix => prefix.every((value, index) => (rawBytes[index] & 255) === value);
  if (mime === 'application/pdf' && !begins([37, 80, 68, 70, 45])) throw new Error('Le contenu ne correspond pas au format PDF.');
  if (mime === 'image/jpeg' && !(begins([255, 216, 255]) && (rawBytes[rawBytes.length - 2] & 255) === 255 && (rawBytes[rawBytes.length - 1] & 255) === 217)) throw new Error('Le contenu ne correspond pas au format JPEG.');
  if (mime === 'image/png' && !begins([137, 80, 78, 71, 13, 10, 26, 10])) throw new Error('Le contenu ne correspond pas au format PNG.');
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    if (!begins([80, 75, 3, 4])) throw new Error('Le contenu ne correspond pas au format DOCX.');
    pDocZipCheck_(Array.from(rawBytes, value => value & 255));
  }
}

function pDocPrivateFolder_() {
  const folderId = pProperties_().getProperty('PORTAL_FOLDER_ID');
  if (!folderId) throw new Error('Le stockage des documents doit être configuré par le responsable.');
  const folder = DriveApp.getFolderById(folderId);
  if (folder.getSharingAccess() !== DriveApp.Access.PRIVATE || folder.getEditors().length || folder.getViewers().length) {
    throw new Error('Le dossier des documents doit être privé, sans autre utilisateur partagé.');
  }
  return folder;
}

function pUploadDocument_(actor, payload) {
  pDocActor_(actor);
  const p = payload || {}, staff = pDocStaff_(actor);
  const visibility = p.visibility || 'PRIVATE';
  if (!['PRIVATE', 'STAFF', 'POOL'].includes(visibility) || (!staff && visibility !== 'PRIVATE')) throw new Error('Destination du document non autorisée.');
  const monitorId = visibility === 'PRIVATE' ? String(p.monitorId || actor.monitorId || '') : '';
  if (!staff && monitorId !== actor.monitorId) throw new Error('Vous pouvez déposer uniquement vos propres documents.');
  if (visibility === 'PRIVATE' && (!monitorId || !pPeople_().some(person => person.id === monitorId && person.active === true))) throw new Error('Personne active introuvable dans l’équipe.');
  const title = pDocText_(p.title, 180, true), category = pDocText_(p.category || 'AUTRE', 30, true);
  if (!['CONTRAT', 'ATTESTATION', 'AUTRE', 'GENERAL'].includes(category) || (!staff && category === 'GENERAL')) throw new Error('Catégorie du document non autorisée.');
  const contractRef = pDocText_(p.contractRef, 180, false);
  if (contractRef) {
    const contract = pDocResolve_(contractRef);
    if (!contract || !pDocCanRead_(actor, contract) || contract.category !== 'CONTRAT' || contract.monitorId !== monitorId) {
      throw new Error('Le contrat sélectionné ne correspond pas à ce moniteur.');
    }
  }
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(String(p.requestId || ''))) throw new Error('Identifiant du dépôt manquant. Réessayez depuis le formulaire.');
  const mime = String(p.mime || ''), filename = pDocFilename_(p.filename, mime);
  const encoded = p.base64;
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > Math.ceil(P_DOCUMENT_LIMIT_ / 3) * 4 ||
      encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('Fichier incorrect ou trop volumineux : 6 Mo maximum.');
  }
  const contentHash = pHash_(encoded), id = 'doc_' + pHash_(actor.id + ':' + p.requestId).slice(0, 40);
  const fingerprint = pHash_(JSON.stringify({title, category, visibility, monitorId, contractRef, filename, mime, contentHash}));
  const existing = pGet_('DOCUMENTS', id);
  if (existing) {
    if (existing.uploadedBy !== actor.id || existing.fingerprint !== fingerprint) throw new Error('Ce dépôt existe déjà avec un contenu différent.');
    return pDocPublic_(existing);
  }
  const bytes = Utilities.base64Decode(encoded);
  if (!bytes.length || bytes.length > P_DOCUMENT_LIMIT_) throw new Error('Fichier trop volumineux : 6 Mo maximum.');
  pDocCheckBytes_(bytes, mime);
  const folder = pDocPrivateFolder_();
  const file = folder.createFile(Utilities.newBlob(bytes, mime, filename));
  const document = {id, monitorId, title, category, visibility, status: 'TO_REVIEW', revision: 1,
    createdAt: pNow_(), uploadedBy: actor.id, fileId: file.getId(), filename, mime, size: bytes.length,
    contractRef, requestId: p.requestId, fingerprint};
  try {
    const changes = [{table: 'DOCUMENTS', record: document}];
    if (visibility === 'PRIVATE') {
      const url = pProperties_().getProperty('APP_URL') || '';
      changes.push(pQueueMail_('document:' + id, pDirectorEmail_(), 'AtoutSport — nouveau document à vérifier',
        actor.name + ' a déposé un document : ' + title + '.\nConnectez-vous au portail pour le vérifier.\n' + url));
    }
    pCommit_(changes, actor, 'DOCUMENT_UPLOADED');
  } catch (error) {
    // Une réponse réseau perdue peut suivre une transaction réussie : préserver le fichier si la ligne existe.
    let committed = null, checked = false;
    try { committed = pGet_('DOCUMENTS', id); checked = true; } catch (ignored) {}
    if (committed && committed.fileId === document.fileId) return pDocPublic_(committed);
    if (checked) { try { file.setTrashed(true); } catch (ignored) {} }
    throw new Error('Le dépôt n’a pas pu être confirmé. Réessayez avec le même fichier.');
  }
  return pDocPublic_(document);
}

function pDownloadDocument_(actor, payload) {
  pDocActor_(actor);
  const document = pDocResolve_((payload || {}).id);
  if (!pDocCanRead_(actor, document)) throw new Error('Document introuvable ou accès non autorisé.');
  const file = DriveApp.getFileById(document.fileId);
  if (file.isTrashed()) throw new Error('Ce document n’est plus disponible.');
  const limit = document.legacy ? 10 * 1024 * 1024 : P_DOCUMENT_LIMIT_;
  if (file.getSize() > limit) throw new Error('Ce document est trop volumineux pour le téléchargement depuis le portail.');
  const blob = file.getBlob(), mime = blob.getContentType();
  const filename = pDocFilename_(document.filename || file.getName(), mime), bytes = blob.getBytes();
  if (!bytes.length || bytes.length > limit) throw new Error('Document vide ou trop volumineux.');
  pDocCheckBytes_(bytes, mime);
  return {filename, mime, base64: Utilities.base64Encode(bytes)};
}

function pReviewDocument_(actor, payload) {
  pDocActor_(actor);
  const p = payload || {}, document = pDocResolve_(p.id);
  if (!document || !pDocCanRead_(actor, document)) throw new Error('Document introuvable ou accès non autorisé.');
  if (document.legacy) throw new Error('Ce document provient de l’administration existante et reste en lecture seule ici.');
  if (!Number.isInteger(p.revision) || document.revision !== p.revision) throw new Error('Le document a changé. Actualisez la liste.');
  if (!['VERIFIED', 'ARCHIVED'].includes(p.status)) throw new Error('Statut du document incorrect.');
  if (actor.role !== 'DIRECTOR' && !(pDocStaff_(actor) && document.visibility !== 'PRIVATE' && p.status === 'ARCHIVED')) throw new Error('Cette décision est réservée à la direction.');
  if (document.status === 'ARCHIVED') throw new Error('Ce document est archivé.');
  if (document.status === p.status) return pDocPublic_(document);
  const next = {...document, status: p.status, ...(p.status === 'ARCHIVED' ? {preArchiveStatus:document.status} : {}), revision: document.revision + 1, reviewedAt: pNow_(), reviewedBy: actor.id};
  pCommit_([{table: 'DOCUMENTS', record: next}], actor, p.status === 'VERIFIED' ? 'DOCUMENT_VERIFIED' : 'DOCUMENT_ARCHIVED');
  return pDocPublic_(next);
}


// ===== Mail.gs =====
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


// ===== Setup.gs =====
/* Installation publique : nouveau projet et ressources indépendantes.
 * Ces fonctions finissent par _ : elles ne sont pas exposées à google.script.run.
 * Aucune adresse, donnée, clé ou ressource du club d'origine n'est intégrée.
 */
function pRequireInstaller_(){
 const expected=String(pProperties_().getProperty('INSTALLER_EMAIL')||'').trim().toLowerCase();
 const email=String(Session.getActiveUser().getEmail()||'').trim().toLowerCase();
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(expected)||!email||email!==expected)throw Error('Définissez INSTALLER_EMAIL et exécutez cette fonction avec ce compte dans l’éditeur Apps Script.');
 return {id:'INSTALLER',email};
}
function pInitialDirector_(){
 const p=pProperties_(),email=String(p.getProperty('INITIAL_DIRECTOR_EMAIL')||'').trim().toLowerCase(),name=String(p.getProperty('INITIAL_DIRECTOR_NAME')||'').trim();
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.endsWith('.test')||email.endsWith('.invalid')||!name||name.length>100)throw Error('Renseignez INITIAL_DIRECTOR_EMAIL et INITIAL_DIRECTOR_NAME avec votre propre responsable.');
 return {email,name,role:'DIRECTOR',bootstrapKey:'director'};
}
function pEnsureTable_(book,name,headers){
 let sheet=book.getSheetByName(name);
 if(!sheet)sheet=book.insertSheet(name);
 const width=sheet.getLastColumn();
 if(width){
  const actual=sheet.getRange(1,1,1,width).getValues()[0];
  if(JSON.stringify(actual)!==JSON.stringify(headers))throw Error('Colonnes incompatibles : '+name+'. Aucune donnée existante n’a été écrasée.');
  return;
 }
 sheet.getRange(1,1,1,headers.length).setValues([headers]).setFontWeight('bold');
 sheet.setFrozenRows(1);
}
function pConfiguredBook_(key,title){
 const props=pProperties_();let id=props.getProperty(key);
 if(!id){const book=SpreadsheetApp.create(title);id=book.getId();props.setProperty(key,id);return book;}
 return SpreadsheetApp.openById(id);
}
function pEnsureSourceBooks_(){
 const p=pProperties_();
 const configured=['TV_BOOK_ID','ADMIN_BOOK_ID','PORTAL_BOOK_ID'].map(k=>p.getProperty(k)).filter(Boolean);
 if(new Set(configured).size!==configured.length)throw Error('Les trois classeurs doivent être distincts.');
 const tv=pConfiguredBook_('TV_BOOK_ID','AtoutSport — Planning et affichage');
 const admin=pConfiguredBook_('ADMIN_BOOK_ID','AtoutSport — Administration privée');
 for(const [name,headers] of Object.entries(P_PUBLIC_TV_TABLES_))pEnsureTable_(tv,name,headers);
 for(const [name,headers] of Object.entries({...P_PUBLIC_PRIVATE_TABLES_,...P_PUBLIC_SPORT_TABLES_}))pEnsureTable_(admin,name,headers);
 for(const [key,title] of [['MEDIA_FOLDER_ID','AtoutSport — Médias affichage'],['PHOTO_FOLDER_ID','AtoutSport — Photos affichage'],['PORTAL_FOLDER_ID','AtoutSport — Documents privés']]){
  if(!p.getProperty(key))p.setProperty(key,DriveApp.createFolder(title).getId());
 }
 return {tv,admin};
}
function INSTALL_PORTAL_(){
 const actor=pRequireInstaller_(),director=pInitialDirector_();
 return pWithLock_(()=>{
  const props=pProperties_();
  // Installation et préparation des invitations n'envoient aucun message.
  if(!props.getProperty('APP_EMAIL_ENABLED'))props.setProperty('APP_EMAIL_ENABLED','false');
  const sources=pEnsureSourceBooks_();
  const book=pConfiguredBook_('PORTAL_BOOK_ID','AtoutSport — Portail privé');
  if([sources.tv.getId(),sources.admin.getId()].includes(book.getId()))throw Error('Le portail exige un classeur distinct.');
  for(const table of P_TABLES_)pEnsureTable_(book,table,['ID','JSON']);
  SpreadsheetApp.flush();
  const users=pRows_('USERS');
  if(!users.length){
   const user={...director,id:pId_(),monitorId:'',active:true,deleted:false,uid:'',revision:1,createdAt:pNow_()};
   pCommit_([{table:'USERS',record:user}],actor,'INSTALLER_DIRECTION');
   props.setProperty('DIRECTOR_NOTIFICATION_USER_ID',user.id);
  }
  props.setProperty('PORTAL_INITIAL_ACCOUNTS_SEEDED','true');
  return {portal:book.getUrl(),administration:sources.admin.getUrl(),planning:sources.tv.getUrl(),users:pRows_('USERS').length,notificationsEnabled:props.getProperty('APP_EMAIL_ENABLED')==='true'};
 });
}

const P_PUBLIC_TV_TABLES_ = {
  "SLIDES": [
    "SlideID",
    "Titre",
    "ModeCreation",
    "Image",
    "Template",
    "Message",
    "DateDebut",
    "DateFin",
    "HeureDebut",
    "HeureFin",
    "JoursDeLaSemaine",
    "DureeSecondes",
    "Priorite",
    "Frequence",
    "Ordre",
    "ModeAdaptation",
    "Statut",
    "Active",
    "DerniereModification"
  ],
  "HORAIRES": [
    "HoraireID",
    "MoniteurID",
    "JourSemaine",
    "HeureDebut",
    "HeureFin",
    "DateDebut",
    "DateFin",
    "Actif",
    "Commentaire"
  ],
  "EXCEPTIONS": [
    "ExceptionID",
    "Date",
    "MoniteurID",
    "Type",
    "RemplacantID",
    "HeureDebut",
    "HeureFin",
    "Active",
    "Commentaire"
  ],
  "PRESENCES": [
    "PresenceID",
    "Date",
    "MoniteurID",
    "HeureDebut",
    "HeureFin",
    "Present",
    "Commentaire"
  ],
  "MONITEURS": [
    "MoniteurID",
    "Prenom",
    "Nom",
    "NomAffiche",
    "Fonction",
    "Photo",
    "DateNaissance",
    "Ordre",
    "Actif"
  ],
  "ANNIVERSAIRES": [
    "AnniversaireID",
    "Prenom",
    "Nom",
    "DateNaissance",
    "Photo",
    "Message",
    "Active"
  ],
  "URGENCES": [
    "UrgenceID",
    "Titre",
    "Message",
    "DateDebut",
    "DateFin",
    "DureeSecondes",
    "Frequence",
    "Couleur",
    "Active"
  ],
  "PARAMETRES": [
    "Cle",
    "Valeur"
  ]
};
const P_PUBLIC_PRIVATE_TABLES_ = {
  REMUNERATIONS:['FicheID','MoniteurID','Mois','Statut','Activite','PrixHeure','RetenuePct','ChargePct','CotisationsValidees'],
  AJUSTEMENTS:['CorrectionID','MoniteurID','Date','Minutes','Motif','Active'],
  PAIEMENTS:['PaiementID','MoniteurID','Mois','Date','Montant','Mode','Reference','Note','Active'],
  DOCUMENTS:['DocumentID','MoniteurID','Titre','Type','FichierID','DateDocument','DateFin','Active','CreeLe'],
  CLOTURES:['ClotureID','MoniteurID','Mois','DonneesJSON','SourceRevision','ValideLe','ValidePar','Active','ReouvertureMotif'],
  ARCHIVES:['ArchiveID','TableSource','CleSource','DonneesJSON','ArchiveLe','ArchivePar','Active'],
  PAYROLL_PREFERENCES:['MoniteurID','Standby','ModifieLe','ModifiePar'],
  CONTRACT_DRAFTS:['MoniteurID','DonneesJSON','ModifieLe','ModifiePar'],
  JOURNAL:['EvenementID','Date','Compte','Action','Table','ElementID','AvantJSON','ApresJSON']
};
const P_PUBLIC_SPORT_TABLES_ = {
 EQUIPE_EXTRA:['MoniteurID','Role','Statut','Activites','Nom','Prenom','DateNaissance','Photo','Email','Telephone','Actif','ModifieLe','Adresse'],
 SEANCES:['SeanceID','Secteur','Activite','Titre','Date','HeureDebut','HeureFin','MoniteurID','Lieu','Capacite','Active','Note'],
 ENFANTS:['EnfantID','Nom','Prenom','DateNaissance','Responsable','Contact','Actif'],
 INSCRIPTIONS:['InscriptionID','SeanceID','EnfantID','Statut','Note','Active'],
 SUIVI_MENSUEL:['SuiviID','MoniteurID','Mois','StatutFiche','DateLimite','DateReception','DocumentID','Note']
};

function PREPARER_INVITATIONS_(){
 const actor=pRequireInstaller_();if(!getPortalConfig().configured)throw Error('Renseignez d’abord la configuration Firebase.');
 return pWithLock_(()=>{
  let prepared=0;for(const u of pRows_('USERS').filter(u=>u.active&&!u.deleted&&!u.uid)){
   if(u.inviteHash&&new Date(u.inviteExpiresAt)>new Date())continue;
   const invitation=pInvitation_({...u,revision:u.revision+1});pCommit_(invitation.changes,actor,'PREPARER_INVITATION');prepared++;
  }return {prepared,emailsSent:0};
 });
}
function ACTIVER_NOTIFICATIONS_(){
 pRequireInstaller_();if(!getPortalConfig().configured||!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(pProperties_().getProperty('APP_URL')||''))throw Error('Terminez la configuration du portail.');
 return pWithLock_(()=>{
  const triggers=ScriptApp.getProjectTriggers();
  for(const name of ['pDeliverMail_','pPrepareReminders_']){
   const own=triggers.filter(t=>t.getHandlerFunction()===name);
   for(const duplicate of own.slice(1))ScriptApp.deleteTrigger(duplicate);
   if(!own.length){
    const timer=ScriptApp.newTrigger(name).timeBased();
    if(name==='pDeliverMail_')timer.everyMinutes(5).create();
    else timer.atHour(9).everyDays(1).inTimezone('Europe/Brussels').create();
   }
  }
  pProperties_().setProperty('APP_EMAIL_ENABLED','true');return {enabled:true,deliveryEveryMinutes:5,remindersDailyHour:9,timezone:'Europe/Brussels'};
 });
}
function DESACTIVER_NOTIFICATIONS_(){
 pRequireInstaller_();return pWithLock_(()=>{
  pProperties_().setProperty('APP_EMAIL_ENABLED','false');
  const triggers=ScriptApp.getProjectTriggers().filter(t=>['pDeliverMail_','pPrepareReminders_'].includes(t.getHandlerFunction()));
  for(const trigger of triggers)ScriptApp.deleteTrigger(trigger);
  return {enabled:false,removedTriggers:triggers.length};
 });
}


// ===== LegacyAdmin.gs =====
/* Generated by scripts/build_legacy.py. Source v2.1 remains untouched. */
const P_LEGACY_METHODS_ = ["bootstrap", "loadTable", "saveRow", "reorderSlides", "uploadImage", "getMediaPreview", "loadManagementTable", "payrollReport", "saveManagementRow", "closePayroll", "reopenPayroll", "archiveSchedule", "restoreSchedule", "uploadMonitorDocument", "archiveDocument", "openMonitorDocument", "loadTeam", "saveTeam", "loadSport", "saveSport", "monthlyFollowup", "markContractSent", "loadContractForm", "previewStudentContract", "generateStudentContract", "loadContracts", "uploadSignedContract", "loadMonitorDossier", "setPayrollStandby", "saveContractDraft"];
function pLegacyAccess_(actor,payload) {
 if(!actor || actor.active!==true || !['DIRECTOR','MANAGER','SECRETARY'].includes(actor.role))throw Error('Administration réservée aux responsables.');
 const p=payload||{};
 if(typeof p.method!=='string'||!P_LEGACY_METHODS_.includes(p.method)||!Array.isArray(p.args)||p.args.length>8)throw Error('Commande administrative non autorisée.');
 if(actor.role!=='DIRECTOR') {
  if(['closePayroll','reopenPayroll','uploadSignedContract'].includes(p.method))throw Error('Cette validation est réservée à la direction.');
  if(['previewStudentContract','generateStudentContract'].includes(p.method)&&p.args[0]&&(p.args[0].employerSigned===true||p.args[0].validated===true))throw Error('La validation et la signature employeur sont réservées à la direction.');
  if(p.method==='saveSport'&&p.args[0]==='SUIVI_MENSUEL'&&p.args[1]&&p.args[1].StatutFiche==='VALIDEE')throw Error('Cette validation est réservée à la direction.');
 }
 return p;
}
function pLegacyUi_(actor) {
 if(!actor||actor.active!==true||!['DIRECTOR','MANAGER','SECRETARY'].includes(actor.role))throw Error('Administration réservée aux responsables.');
 const html=HtmlService.createHtmlOutputFromFile('Legacy').getContent().replace('__ATOUT_LEGACY_ROLE__',actor.role);
 return {html};
}
function pLegacy_(actor,payload) {
 const p=pLegacyAccess_(actor,payload),context={actor};
 try {
  if(p.method==='openMonitorDocument'){
   const id=String(p.args[0]||'');
   return {file:pDownloadDocument_(actor,{id:id.startsWith('portal:')?id.slice(7):'legacy:'+id})};
  }
  const legacy=pLegacyFactory_(context);
  if(p.method==='archiveDocument'&&String(p.args[0]||'').startsWith('portal:')){
   pDocArchivePortal_(actor,{id:String(p.args[0]).slice(7),active:p.args[1],revision:p.args[3]});
   return pDocumentsAdminList_(actor,legacy.invoke('loadManagementTable',['DOCUMENTS']));
  }
  const result=legacy.invoke(p.method,p.args);
  if(p.method==='loadMonitorDossier'&&result){
   result.documents=pDocumentsAdminList_(actor,result.documents);
   result.documents.rows=result.documents.rows.filter(row=>row.MoniteurID===result.person.MoniteurID);
   result.contracts.rows=result.contracts.rows.map(row=>{const safe={...row};delete safe.FichierID;return safe;});
  }
  if(p.method==='loadManagementTable'&&p.args[0]==='DOCUMENTS')return pDocumentsAdminList_(actor,result);
  if(['uploadMonitorDocument','archiveDocument'].includes(p.method)&&result){
   const unified=pDocumentsAdminList_(actor,result);
   if(result.createdDocumentId)unified.createdDocumentId=result.createdDocumentId;
   return unified;
  }
  if(['loadContracts','markContractSent','uploadSignedContract'].includes(p.method)&&result&&Array.isArray(result.rows))result.rows=result.rows.map(row=>{const safe={...row};delete safe.FichierID;return safe;});
  if(p.method==='bootstrap'&&result){delete result.sheetUrl;result.accessRole=actor.role;}
  if(p.method==='payrollReport'&&result)delete result.bookUrl;
  if(p.method==='generateStudentContract'&&result){delete result.url;result.file=pDownloadDocument_(actor,{id:'legacy:'+result.id});}
  return result;
 } finally {context.actor=null;}
}
function pLegacyFactory_(context) {
 // portalRpc owns the actual ScriptLock for the whole authenticated transaction.
 const LockService={getScriptLock:()=>({waitLock:()=>{},releaseLock:()=>{}})};
 function legacyMediaAllowed_(reference) {
  const id=mediaId_(reference),props=pProperties_();
  const pinned=String(props.getProperty('MEDIA_READ_ALLOWLIST')||'').split(/[;,\s]+/).filter(Boolean);
  if(pinned.includes(id))return;
  const roots=[props.getProperty('MEDIA_FOLDER_ID')||'',props.getProperty('PHOTO_FOLDER_ID')||''],seen=new Set();
  let pending=[];
  try {
   const parents=DriveApp.getFileById(id).getParents();while(parents.hasNext()&&pending.length<20)pending.push(parents.next());
   while(pending.length&&seen.size<40){const folder=pending.shift(),folderId=folder.getId();if(roots.includes(folderId))return;if(seen.has(folderId))continue;seen.add(folderId);const parents=folder.getParents();while(parents.hasNext()&&pending.length<40)pending.push(parents.next());}
  }catch(ignored){}
  throw Error('Aperçu indisponible. Importez ce média dans le dossier AtoutSport avant de l’utiliser.');
 }
/* Atout Sport ASBL — exécuter l'application en tant qu'utilisateur connecté. */
const BOOK_ID = pProperties_().getProperty('TV_BOOK_ID');
const MEDIA_FOLDER = pProperties_().getProperty('MEDIA_FOLDER_ID') || '';
const TZ = 'Europe/Brussels';
const TABLES = ['SLIDES','HORAIRES','EXCEPTIONS','ANNIVERSAIRES','MONITEURS','URGENCES','PARAMETRES','PRESENCES'];
const BOOLEANS = ['Active','Actif','Present'];
const DAYS = ['Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi','Dimanche'];

function authorize_() { if (!context.actor) throw Error('Contexte administratif terminé.'); return context.actor.email; }
function book_() { authorize_(); return SpreadsheetApp.openById(BOOK_ID); }

function table_(name) {
  if (!TABLES.includes(name)) throw new Error('Table inconnue');
  const sheet = book_().getSheetByName(name);
  if (!sheet) throw new Error('Onglet manquant : '+name);
  return sheet;
}
function rows_(sheet) {
  const values = sheet.getDataRange().getValues(), headers = values.shift();
  return values.filter(r=>r[0]!=='' ).map(row=>Object.fromEntries(headers.map((h,i)=>{
    let v=row[i];
    if (v instanceof Date) {
      const fmt = h.startsWith('Heure') ? 'HH:mm' : (h==='DerniereModification'||sheet.getName()==='URGENCES' && h.startsWith('Date')) ? "yyyy-MM-dd'T'HH:mm" : 'yyyy-MM-dd';
      v=Utilities.formatDate(v,TZ,fmt);
    }
    return [h,v];
  })));
}
function revision_(rows) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,JSON.stringify(rows)));
}
function loadTable_(name) {
  const sheet=table_(name), rows=rows_(sheet);
  return {rows, revision:revision_(rows), headers:sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0]};
}
function bootstrap_() {
  return {email:authorize_(), monitors:teamRows_(), slides:loadTable_('SLIDES'),
    settings:loadTable_('PARAMETRES').rows, sheetUrl:SpreadsheetApp.openById(BOOK_ID).getUrl()};
}
function safeText_(v) {
  const text=String(v??'').trim();
  if (text.length>2000) throw new Error('Texte trop long (2000 caractères maximum).');
  // Empêche qu'une saisie soit interprétée comme formule dans Sheets.
  return /^[=+@]/.test(text) ? "'"+text : text;
}
function date_(v, pattern) {
  try {
    const d=Utilities.parseDate(v,TZ,pattern);
    if (Utilities.formatDate(d,TZ,pattern)!==v) throw new Error();
    return d;
  } catch(e) { throw new Error('Date ou heure invalide : '+v); }
}
function cell_(name,h,v) {
  if (BOOLEANS.includes(h)) return v===true || v==='true';
  if (v===''||v==null) return '';
  if (h.startsWith('Heure')) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new Error('Heure invalide');
    const [hours,minutes]=v.split(':').map(Number);return (hours*60+minutes)/1440;
  }
  if(h==='DerniereModification')return date_(String(v),"yyyy-MM-dd'T'HH:mm");
  if (h==='Date'||h==='DateNaissance'||h==='DateDebut'||h==='DateFin')
    return date_(String(v),name==='URGENCES'?"yyyy-MM-dd'T'HH:mm":'yyyy-MM-dd');
  if (['Ordre','DureeSecondes','Priorite','Frequence'].includes(h)) {
    const n=Number(v), bounds={Ordre:[0,9999],DureeSecondes:[3,600],Priorite:[1,4],Frequence:[1,10]}[h];
    if (!Number.isInteger(n)||n<bounds[0]||n>bounds[1]) throw new Error(h+' hors limites');
    return h==='Priorite'?String(n):n;
  }
  return safeText_(v);
}
function parameterValue_(key,value) {
  if (key==='meteo_lieu') {const text=String(value??'').trim();if(text.length>60)throw new Error('Le lieu est limité à 60 caractères');return safeText_(text)}
  const integers={duree_slide_defaut:[3,600],duree_bienvenue_secondes:[3,600],duree_anniversaire_secondes:[3,600],bienvenue_toutes_les:[1,30],synchronisation_secondes:[15,600],urgence_secondes:[5,600]};
  if (integers[key]) {const n=Number(value),[min,max]=integers[key];if(!Number.isInteger(n)||n<min||n>max)throw new Error('Valeur attendue entre '+min+' et '+max);return String(n)}
  if (key==='bienvenue_message') {const text=String(value??'').trim();if(text.length>220)throw new Error('Le rappel est limité à 220 caractères');return text}
  if (key==='anniversaires_mode') {if(!['MONTH','DAY'].includes(value))throw new Error('Choisir MONTH ou DAY');return value}
  if (key==='meteo_active') {if(![true,false,'TRUE','FALSE'].includes(value))throw new Error('Choisir Oui ou Non');return value===true||value==='TRUE'?'TRUE':'FALSE'}
  if (['latitude','longitude'].includes(key)) {const n=Number(String(value).replace(',','.')),max=key==='latitude'?90:180;if(!Number.isFinite(n)||Math.abs(n)>max)throw new Error('Coordonnée incorrecte');return String(n)}
  throw new Error('Ce paramètre se règle lors de l’installation');
}
function saveRow_(name, row, revision) {
  authorize_();
  const lock=LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const sheet=table_(name), all=rows_(sheet);
    if (revision_(all)!==revision) throw new Error('Le tableau a changé. Recharge-le avant d’enregistrer.');
    const headers=sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0], key=headers[0];
    let id=String(row[key]||'');
    let at=all.findIndex(r=>r[key]===id);
    if (id && at<0) throw new Error('Élément introuvable. Recharge le tableau.');
    if (!id) id=Utilities.getUuid();
    row=Object.assign({},at>=0?all[at]:{},row,{[key]:id});
    if(name==='PARAMETRES') {
      if(at<0)throw new Error('Choisis un paramètre existant');
      row={...all[at],Valeur:parameterValue_(id,row.Valeur)};
    }
    if (['HORAIRES','EXCEPTIONS','PRESENCES'].includes(name)) {
      const ids=rows_(table_('MONITEURS')).map(r=>r.MoniteurID);
      if (!ids.includes(row.MoniteurID)) throw new Error('Choisis un moniteur');
      if (row.Type==='REMPLACEMENT' && (!ids.includes(row.RemplacantID)||row.RemplacantID===row.MoniteurID)) throw new Error('Choisis un autre remplaçant');
    }
    if (name==='HORAIRES' && (!DAYS.includes(row.JourSemaine)||!row.HeureDebut||!row.HeureFin||row.HeureDebut===row.HeureFin)) throw new Error('Jour ou plage horaire incorrect');
    if(name==='PRESENCES') {
      if(!row.Date||!row.HeureDebut||!row.HeureFin||row.HeureDebut===row.HeureFin)throw new Error('Date et plage horaire requises');
      row.DerniereModification=Utilities.formatDate(new Date(),TZ,"yyyy-MM-dd'T'HH:mm");
    }
    if (name==='EXCEPTIONS') {
      if (!['ABSENCE','REMPLACEMENT','MODIFICATION'].includes(row.Type)||!row.Date) throw new Error('Type ou date manquant');
      if (!!row.HeureDebut!==!!row.HeureFin || row.Type==='MODIFICATION'&&!row.HeureDebut) throw new Error('Renseigne les deux heures');
    }
    if (name==='SLIDES') {
      if (!row.Titre || row.Titre.length>90) throw new Error('Titre requis (90 caractères maximum)');
      if (String(row.Message||'').length>600) throw new Error('Message : 600 caractères maximum');
      if (!['IMAGE','GENEREE','VIDEO'].includes(row.ModeCreation)) throw new Error('Type invalide');
      if (row.ModeCreation==='GENEREE'&&!row.Message) throw new Error('Message obligatoire');
      if (row.ModeCreation!=='GENEREE'&&!row.Image) throw new Error('Ajoute un média ou son lien Drive');
      if (!['BROUILLON','A_VALIDER','PUBLIE'].includes(row.Statut)) throw new Error('Statut invalide');
      if (!['CONTAIN','COVER','BLUR'].includes(row.ModeAdaptation)) throw new Error('Adaptation invalide');
      if (String(row.JoursDeLaSemaine||'').split(';').filter(Boolean).some(d=>!DAYS.includes(d))) throw new Error('Jour invalide');
    }
    if (name==='ANNIVERSAIRES'&&(!row.Prenom||!row.DateNaissance)) throw new Error('Prénom et date requis');
    if (name==='MONITEURS'&&!row.Prenom) throw new Error('Prénom requis');
    if (row.DateDebut&&row.DateFin&&row.DateDebut>row.DateFin) throw new Error('La fin précède le début');
    if (name==='URGENCES') {
      if (String(row.Message||'').length>600 || String(row.Titre||'').length>90) throw new Error('Titre : 90 caractères, message : 600 caractères maximum');
      if (!row.Message||!row.DateFin) throw new Error('Message et expiration requis');
      if (row.Active===true && date_(row.DateFin,"yyyy-MM-dd'T'HH:mm")<=new Date()) throw new Error('L’expiration est déjà passée');
      if (!/^#[0-9a-f]{6}$/i.test(row.Couleur||'')) throw new Error('Couleur invalide');
      row.PubliePar=authorize_();
    }
    // Préserve les valeurs des colonnes non présentées dans le formulaire.
    const values=headers.map(h=>cell_(name,h,row[h]));
    const targetRow=at>=0?sheet.getRange(2,1,sheet.getLastRow()-1,1).getValues().findIndex(r=>r[0]===id)+2:sheet.getLastRow()+1;
    if(at<0)extendTable_(sheet,targetRow);
    sheet.getRange(targetRow,1,1,headers.length).setValues([values]);
    SpreadsheetApp.flush();
    return loadTable_(name);
  } finally {lock.releaseLock();}
}
function reorderSlides_(ids,revision) {
  authorize_();const lock=LockService.getScriptLock();lock.waitLock(10000);
  try {
    const sheet=table_('SLIDES'),rows=rows_(sheet);
    if(revision_(rows)!==revision)throw new Error('Le tableau a changé. Recharge-le.');
    if(ids.length!==rows.length||new Set(ids).size!==rows.length||ids.some(id=>!rows.some(r=>r.SlideID===id)))throw new Error('Ordre invalide');
    const h=sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0], col=h.indexOf('Ordre')+1;
    const raw=sheet.getRange(2,1,sheet.getLastRow()-1,1).getValues();
    raw.forEach((r,i)=>{if(r[0])sheet.getRange(i+2,col).setValue((ids.indexOf(r[0])+1)*10)});
    SpreadsheetApp.flush();return loadTable_('SLIDES');
  } finally {lock.releaseLock();}
}
function uploadImage_(payload,category) {
  authorize_();
  if(!['image/jpeg','image/png','image/webp'].includes(payload.type))throw new Error('Image JPG, PNG ou WebP requise. Dépose les vidéos directement dans Drive.');
  if(typeof payload.data!=='string'||payload.data.length>14000000)throw new Error('Image trop lourde (10 Mo maximum)');
  const bytes=Utilities.base64Decode(payload.data);
  if(bytes.length>10*1024*1024)throw new Error('Image trop lourde');
  const name=String(payload.name||'image').replace(/[^a-zA-Z0-9._-]/g,'_');
  const folder=category==='MONITEURS'?(pProperties_().getProperty('PHOTO_FOLDER_ID')||''):MEDIA_FOLDER;
  const file=DriveApp.getFolderById(folder).createFile(Utilities.newBlob(bytes,payload.type,Utilities.getUuid()+'-'+name));
  return {id:file.getId(),name:file.getName()};
}

// L'API conserve les types de colonnes, menus et cases du tableau natif.
function extendTable_(sheet,endRow) {
  const url='https://sheets.googleapis.com/v4/spreadsheets/'+BOOK_ID;
  const options={headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()}};
  const response=UrlFetchApp.fetch(url+'?fields=sheets(properties(sheetId),tables)',options);
  const tab=JSON.parse(response.getContentText()).sheets.find(s=>s.properties.sheetId===sheet.getSheetId());
  const table=(tab.tables||[])[0];if(!table)return;
  let fields='range';table.range.endRowIndex=Math.max(table.range.endRowIndex||0,endRow);
  if(sheet.getName()==='SLIDES') {
    const mode=(table.columnProperties||[]).find(c=>c.columnName==='ModeCreation');
    if(mode && mode.columnType==='DROPDOWN') {
      mode.dataValidationRule={condition:{type:'ONE_OF_LIST',values:['IMAGE','GENEREE','VIDEO'].map(v=>({userEnteredValue:v}))}};
      fields+=',columnProperties';
    }
  }
  const payload={requests:[{updateTable:{table,fields}}]};
  UrlFetchApp.fetch(url+':batchUpdate',{...options,method:'post',contentType:'application/json',payload:JSON.stringify(payload)});
}

/* Vignettes privées : les médias restent dans Drive, sans lien rendu public. */
function mediaId_(reference) {
  const value=String(reference||'').trim();
  if (/^[A-Za-z0-9_-]{10,}$/.test(value)) return value;
  if (!/^https:\/\/(drive|docs)\.google\.com\//i.test(value)) throw new Error('Utilise un lien Google Drive ou l’identifiant du fichier.');
  const match=value.match(/\/d\/([A-Za-z0-9_-]{10,})/) || value.match(/[?&]id=([A-Za-z0-9_-]{10,})(?:&|$)/);
  if(!match)throw new Error('Lien de média non reconnu.');
  return match[1];
}
function getMediaPreview_(reference) {
  legacyMediaAllowed_(reference);
  authorize_();
  const id=mediaId_(reference), file=DriveApp.getFileById(id);
  const type=file.getMimeType();
  if(!/^image\//.test(type)&&!/^video\//.test(type))return {available:false};
  const modified=file.getLastUpdated().getTime(), cache=CacheService.getUserCache();
  const key='thumb-'+id+'-'+modified, hit=cache.get(key);
  if(hit)return JSON.parse(hit);
  let blob=file.getThumbnail();
  if(!blob && ['image/jpeg','image/png','image/webp'].includes(type) && file.getSize()<=2*1024*1024)blob=file.getBlob();
  if(!blob)return {available:false};
  if(!['image/jpeg','image/png','image/webp','image/gif'].includes(blob.getContentType()))return {available:false};
  const bytes=blob.getBytes();
  if(bytes.length>2*1024*1024)return {available:false};
  const result={available:true,type:blob.getContentType(),data:Utilities.base64Encode(bytes)};
  const encoded=JSON.stringify(result);
  if(encoded.length<90000)cache.put(key,encoded,300);
  return result;
}


// Outil de contrôle privé : même interface et même API dans des largeurs définies.
// Ce mode est réservé, comme toute l’application, aux administrateurs autorisés.
function responsivePreview_() {
  const source=HtmlService.createHtmlOutputFromFile('Index').getContent()
    .replace('<script>', '<script>window.google=parent.google;');
  const safe=JSON.stringify(source).replace(/</g,'\\u003c');
  const page='<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>body{margin:0;background:#dce3e4;font:14px system-ui;color:#173e48}header{display:flex;align-items:center;gap:12px;padding:12px 18px;background:white;border-bottom:1px solid #cbd8da}button{font:inherit;padding:8px 12px;border:1px solid #cad5d8;border-radius:6px;background:white;cursor:pointer}iframe{display:block;margin:18px auto;border:1px solid #cbd8da;background:white;height:calc(100vh - 100px)}strong{margin-right:auto}</style></head><body><header><strong>AtoutSport · Vérification des formats</strong><button data-width="390">Téléphone 390 px</button><button data-width="820">iPad 820 px</button><button data-width="1180">Ordinateur 1180 px</button></header><iframe title="Interface AtoutSport" id="format" style="width:390px"></iframe><script>const frame=document.getElementById("format");frame.srcdoc='+safe+';document.querySelectorAll("button").forEach(b=>b.onclick=()=>frame.style.width=b.dataset.width+"px");</script></body></html>';
  return HtmlService.createHtmlOutput(page).setTitle('AtoutSport · Vérification responsive').addMetaTag('viewport','width=device-width, initial-scale=1');
}

/* Calcul mensuel indépendant des services Google. Minutes entières et centimes. */
function payTrue_(v) { return v===true||v===1||String(v).toUpperCase()==='TRUE'; }
function payMonth_(s) {
  if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(String(s)))throw new Error('Mois attendu : AAAA-MM');
  return String(s);
}
function payDate_(s) {
  if(!/^20\d{2}-\d{2}-\d{2}$/.test(String(s)))throw new Error('Date attendue : AAAA-MM-JJ');
  const d=new Date(s+'T00:00:00Z');
  if(!Number.isFinite(+d)||d.toISOString().slice(0,10)!==s)throw new Error('Date invalide');
  return d;
}
function payTime_(v) {
  if(typeof v==='number'&&v>=0&&v<1)return Math.round(v*1440)%1440;
  const s=String(v);if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(s))throw new Error('Heure invalide dans le planning : '+s);
  return Number(s.slice(0,2))*60+Number(s.slice(3));
}
function paySpan_(r) {
  const a=payTime_(r.HeureDebut);let b=payTime_(r.HeureFin);
  if(a===b)throw new Error('Une plage de durée nulle doit être corrigée.');
  if(b<a)b+=1440;return [a,b];
}
function paySet_(rows) {const s=new Set();for(const r of rows){const [a,b]=paySpan_(r);for(let i=a;i<b;i++)s.add(i)}return s;}
function payCount_(s,offset,limit) {let n=0;for(const i of s)if(i+offset>=0&&i+offset<limit)n++;return n;}
function payNumber_(v,min,max,label) {
  if(v===''||v===null||v===undefined)throw new Error(label+' manquant');
  const n=Number(String(v).replace(',','.'));
  if(!Number.isFinite(n)||n<min||n>max)throw new Error(label+' incorrect');return n;
}
function payCents_(v) {return Math.round((v+Number.EPSILON)*100);}
function calculatePayroll_(input,month) {
  payMonth_(month);
  const begin=payDate_(month+'-01'),end=new Date(Date.UTC(begin.getUTCFullYear(),begin.getUTCMonth()+1,1));
  const limit=(end-begin)/60000,days=limit/1440;
  const monitors=input.monitors||[],weekly=input.weekly||[],presences=input.presences||[],exceptions=input.exceptions||[];
  const ids=new Set(monitors.map(m=>m.MoniteurID));
  const reports=Object.fromEntries(monitors.map(m=>[m.MoniteurID,{id:m.MoniteurID,nom:m.Nom||'',prenom:m.Prenom||'',name:m.NomAffiche||[m.Prenom,m.Nom].filter(Boolean).join(' '),active:payTrue_(m.Actif),month,planned:0,changed:0,absent:0,replacement:0,adjustment:0,actual:0,weekly:0,occurrences:{},schedule:[],details:[],warnings:[]} ]));
  const warning=(mid,text)=>{if(reports[mid]&&!reports[mid].warnings.includes(text))reports[mid].warnings.push(text)};
  // Une minute chevauchante n'est jamais rémunérée deux fois.
  for(const m of monitors){const r=reports[m.MoniteurID];for(const day of DAYS){const rows=weekly.filter(h=>h.MoniteurID===m.MoniteurID&&h.JourSemaine===day&&payTrue_(h.Actif)&&(!h.DateDebut||h.DateDebut<end.toISOString().slice(0,10))&&(!h.DateFin||h.DateFin>=month+'-01'));
    const unique=paySet_(rows);r.weekly+=unique.size;
    const seen=new Set();for(const h of rows){const span=String(h.HeureDebut)+'–'+String(h.HeureFin),key=day+' '+span;if(!seen.has(key)){r.schedule.push(key);seen.add(key)}}
    r.occurrences[day]=0;
  }}
  const absoluteSeen=Object.fromEntries([...ids].map(id=>[id,new Set()]));
  // Le jour précédent permet de compter correctement une plage traversant minuit.
  for(let dayIndex=-1;dayIndex<days;dayIndex++){
    const date=new Date(+begin+dayIndex*86400000).toISOString().slice(0,10),weekday=DAYS[(new Date(date+'T00:00Z').getUTCDay()+6)%7],offset=dayIndex*1440;
    const shifts={},ledger={};
    for(const m of monitors){const id=m.MoniteurID,r=reports[id],rows=weekly.filter(h=>payTrue_(h.Actif)&&h.MoniteurID===id&&h.JourSemaine===weekday&&(!h.DateDebut||date>=h.DateDebut)&&(!h.DateFin||date<=h.DateFin));
      const base=paySet_(rows),raw=rows.reduce((a,h)=>{const [s,e]=paySpan_(h);return a+e-s},0);
      if(raw>base.size)warning(id,'Chevauchement du planning : minutes communes comptées une seule fois.');
      if(dayIndex>=0&&base.size)r.occurrences[weekday]++;
      const dated=presences.filter(p=>p.MoniteurID===id&&p.Date===date);
      shifts[id]=dated.length?paySet_(dated.filter(p=>payTrue_(p.Present))):new Set(base);
      const b=payCount_(base,offset,limit),p=payCount_(shifts[id],offset,limit);
      ledger[id]={date,planned:b,changed:p-b,absent:0,replacement:0,adjustment:0,actual:0};
    }
    for(const e of exceptions.filter(e=>payTrue_(e.Active)&&e.Date===date)){
      if(!ids.has(e.MoniteurID))continue;
      const id=e.MoniteurID,current=shifts[id];
      if(e.Type==='MODIFICATION'){
        const next=paySet_([e]);ledger[id].changed+=payCount_(next,offset,limit)-payCount_(current,offset,limit);shifts[id]=next;continue;
      }
      if(!['ABSENCE','REMPLACEMENT'].includes(e.Type))continue;
      if(e.Type==='REMPLACEMENT'&&(!ids.has(e.RemplacantID)||e.RemplacantID===id)){warning(id,'Remplaçant incorrect : exception non appliquée.');continue;}
      if(Boolean(e.HeureDebut)!==Boolean(e.HeureFin))throw new Error('Exception avec une seule heure : '+e.ExceptionID);
      const [a,b]=e.HeureDebut?paySpan_(e):[0,2880];let removed=0,added=0;
      for(const i of Array.from(current)){if(i<a||i>=b)continue;current.delete(i);
        const counted=i+offset>=0&&i+offset<limit;if(counted)removed++;
        if(e.Type==='REMPLACEMENT'){
          const target=shifts[e.RemplacantID];
          if(!target.has(i)){target.add(i);if(counted)added++;}else warning(e.RemplacantID,'Remplacement chevauchant son horaire : minutes communes comptées une seule fois.');
        }
      }
      ledger[id].absent+=removed;
      if(e.Type==='REMPLACEMENT')ledger[e.RemplacantID].replacement+=added;
      if(!removed&&dayIndex>=0)warning(id,'Exception du '+date+' sans heure planifiée correspondante.');
    }
    for(const id of ids){for(const minute of shifts[id]){const abs=offset+minute;if(abs<0||abs>=limit)continue;if(absoluteSeen[id].has(abs))throw new Error('Chevauchement de nuit sur deux dates pour '+reports[id].name+' : corriger le planning.');absoluteSeen[id].add(abs)}const d=ledger[id];d.actual=payCount_(shifts[id],offset,limit);if(Object.values(d).some(v=>typeof v==='number'&&v!==0))reports[id].details.push(d);}
  }
  for(const a of input.adjustments||[]){if(!payTrue_(a.Active)||String(a.Date).slice(0,7)!==month||!reports[a.MoniteurID])continue;payDate_(a.Date);const minutes=payNumber_(a.Minutes,-1440,1440,'Correction');if(!Number.isInteger(minutes))throw new Error('Correction attendue en minutes entières');reports[a.MoniteurID].details.push({date:a.Date,planned:0,changed:0,absent:0,replacement:0,adjustment:minutes,actual:minutes,note:a.Motif||''});}
  for(const r of Object.values(reports)){
    r.details.sort((a,b)=>a.date.localeCompare(b.date));for(const d of r.details)for(const k of ['planned','changed','absent','replacement','adjustment','actual'])r[k]+=d[k];
    if(r.actual!==r.planned+r.changed-r.absent+r.replacement+r.adjustment)throw new Error('Décompte incohérent : '+r.name);
    const profiles=(input.rates||[]).filter(p=>p.MoniteurID===r.id&&p.Mois===month);
    if(profiles.length>1)throw new Error('Plusieurs tarifs pour '+r.name+' et '+month);
    r.profile=profiles[0]||{};r.status=r.profile.Statut||'À renseigner';r.activity=r.profile.Activite||'';
    r.rate=null;r.gross=null;r.deduction=null;r.charge=null;r.due=null;r.cost=null;
    if(r.profile.PrixHeure!==''&&r.profile.PrixHeure!=null){r.rate=payNumber_(r.profile.PrixHeure,0,1000,'Tarif');r.gross=payCents_(r.actual/60*r.rate);}
    if(r.rate===null)warning(r.id,'Tarif horaire manquant.');
    if(r.actual<0){warning(r.id,'Heures négatives : corriger les ajustements.');r.gross=null;}
    if(!payTrue_(r.profile.CotisationsValidees))warning(r.id,'Retenue et charge employeur à confirmer.');
    else if(r.gross!==null){const retenue=payNumber_(r.profile.RetenuePct,0,100,'Retenue'),charge=payNumber_(r.profile.ChargePct,0,100,'Charge employeur');r.deduction=Math.round(r.gross*retenue/100);r.charge=Math.round(r.gross*charge/100);r.due=r.gross-r.deduction;r.cost=r.gross+r.charge;}
    r.paid=(input.payments||[]).filter(p=>p.MoniteurID===r.id&&p.Mois===month&&payTrue_(p.Active)).reduce((sum,p)=>sum+payCents_(payNumber_(p.Montant,0,1000000,'Paiement')),0);
    r.balance=r.due===null?null:r.due-r.paid;
    r.equivalentWeeks=r.weekly?r.actual/r.weekly:null;
    r.weeklyAmount=r.rate===null?null:payCents_(r.weekly/60*r.rate);
  }
  return {month,rows:Object.values(reports),days};
}

/* Données privées de gestion : jamais lues par le Raspberry. */
const MANAGEMENT_BOOK = pProperties_().getProperty('ADMIN_BOOK_ID');
const PRIVATE_TABLES = {
  REMUNERATIONS:['FicheID','MoniteurID','Mois','Statut','Activite','PrixHeure','RetenuePct','ChargePct','CotisationsValidees'],
  AJUSTEMENTS:['CorrectionID','MoniteurID','Date','Minutes','Motif','Active'],
  PAIEMENTS:['PaiementID','MoniteurID','Mois','Date','Montant','Mode','Reference','Note','Active'],
  DOCUMENTS:['DocumentID','MoniteurID','Titre','Type','FichierID','DateDocument','DateFin','Active','CreeLe'],
  CLOTURES:['ClotureID','MoniteurID','Mois','DonneesJSON','SourceRevision','ValideLe','ValidePar','Active','ReouvertureMotif'],
  ARCHIVES:['ArchiveID','TableSource','CleSource','DonneesJSON','ArchiveLe','ArchivePar','Active'],
  PAYROLL_PREFERENCES:['MoniteurID','Standby','ModifieLe','ModifiePar'],
  CONTRACT_DRAFTS:['MoniteurID','DonneesJSON','ModifieLe','ModifiePar'],
  JOURNAL:['EvenementID','Date','Compte','Action','Table','ElementID','AvantJSON','ApresJSON']
};
function privateBook_(){authorize_();return SpreadsheetApp.openById(MANAGEMENT_BOOK);}
function privateSheet_(name){if(!PRIVATE_TABLES[name])throw new Error('Table privée inconnue');let sheet=privateBook_().getSheetByName(name);if(!sheet&&['PAYROLL_PREFERENCES','CONTRACT_DRAFTS'].includes(name)){sheet=privateBook_().insertSheet(name);sheet.getRange(1,1,1,PRIVATE_TABLES[name].length).setValues([PRIVATE_TABLES[name]]);sheet.setFrozenRows(1);SpreadsheetApp.flush();}if(!sheet)throw new Error('Gestion privée non installée');const headers=sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];if(JSON.stringify(headers)!==JSON.stringify(PRIVATE_TABLES[name]))throw new Error('Colonnes de gestion modifiées : '+name);return sheet;}
function privateRows_(name){if(['PAYROLL_PREFERENCES','CONTRACT_DRAFTS'].includes(name)&&!privateBook_().getSheetByName(name))return [];return rows_(privateSheet_(name));}
function privateLoad_(name){const rows=privateRows_(name);return {rows,revision:revision_(rows),headers:PRIVATE_TABLES[name]};}
function loadManagementTable_(name){authorize_();if(!['REMUNERATIONS','AJUSTEMENTS','PAIEMENTS','DOCUMENTS','ARCHIVES'].includes(name))throw new Error('Table non consultable');return privateLoad_(name);}
function auditStamp_(){return Utilities.formatDate(new Date(),TZ,"yyyy-MM-dd'T'HH:mm:ss");}
function privateValue_(value){return typeof value==='boolean'?{boolValue:value}:typeof value==='number'?{numberValue:value}:{stringValue:String(value??'')};}
function privateWrite_(name,row,action,before){
  const sheet=privateSheet_(name),headers=PRIVATE_TABLES[name],key=headers[0],all=privateRows_(name),at=all.findIndex(r=>r[key]===row[key]);
  const raw=sheet.getLastRow()>1?sheet.getRange(2,1,sheet.getLastRow()-1,1).getValues():[];
  const target=at>=0?raw.findIndex(r=>r[0]===row[key])+1:sheet.getLastRow();
  const journal=privateSheet_('JOURNAL'),audit={EvenementID:Utilities.getUuid(),Date:auditStamp_(),Compte:authorize_(),Action:action,Table:name,ElementID:row[key],AvantJSON:JSON.stringify(before||{}),ApresJSON:JSON.stringify(row)};
  const cells=hs=>hs.map(h=>({userEnteredValue:privateValue_(row[h])}));
  const requests=[{updateCells:{range:{sheetId:sheet.getSheetId(),startRowIndex:target,endRowIndex:target+1,startColumnIndex:0,endColumnIndex:headers.length},rows:[{values:cells(headers)}],fields:'userEnteredValue'}},{appendCells:{sheetId:journal.getSheetId(),rows:[{values:PRIVATE_TABLES.JOURNAL.map(h=>({userEnteredValue:privateValue_(audit[h])}))}],fields:'userEnteredValue'}}];
  if(target>=sheet.getMaxRows())requests.unshift({appendDimension:{sheetId:sheet.getSheetId(),dimension:'ROWS',length:100}});
  const response=UrlFetchApp.fetch('https://sheets.googleapis.com/v4/spreadsheets/'+MANAGEMENT_BOOK+':batchUpdate',{method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},payload:JSON.stringify({requests}),muteHttpExceptions:true});
  if(response.getResponseCode()>=300)throw new Error('Enregistrement privé impossible ('+response.getResponseCode()+'). Réessayez.');
}
function managementSources_(){return {monitors:teamRows_(),weekly:rows_(table_('HORAIRES')),presences:rows_(table_('PRESENCES')),exceptions:rows_(table_('EXCEPTIONS')),rates:privateRows_('REMUNERATIONS'),adjustments:privateRows_('AJUSTEMENTS'),payments:privateRows_('PAIEMENTS')};}
// Adapté au portail lors du build. Les déclarations ne changent pas le calcul v2.
function managementDeclarations_(month){return pRows_('TIMESHEETS').filter(row=>row.month===month);}
function payrollPreference_(mid,rows){const matches=(rows||privateRows_('PAYROLL_PREFERENCES')).filter(r=>r.MoniteurID===mid);if(matches.length>1)throw new Error('Plusieurs préférences de paiement pour ce moniteur.');const row=matches[0]||null;return {standby:row?payTrue_(row.Standby):false,revision:revision_(row),row};}
function setPayrollStandby_(mid,standby,revision){
  authorize_();if(typeof standby!=='boolean')throw new Error('Choisissez une mise en veille ou une reprise.');requireMonitor_(mid);const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{const before=payrollPreference_(mid);if(before.revision!==revision)throw new Error('La préférence a changé. Rechargez la fiche.');const row={MoniteurID:mid,Standby:standby,ModifieLe:auditStamp_(),ModifiePar:authorize_()};privateWrite_('PAYROLL_PREFERENCES',row,standby?'PAIEMENTS_EN_VEILLE':'PAIEMENTS_REPRENDRE',before.row);return {standby,revision:revision_(row)};}finally{lock.releaseLock();}
}
function payrollActivity_(row,source,month,sessions,declarations){
  const reasons=[],id=row.id,inMonth=r=>String(r.Date||'').slice(0,7)===month;
  if(row.planned||row.weekly)reasons.push('Planning');
  if((source.presences||[]).some(r=>r.MoniteurID===id&&inMonth(r)))reasons.push('Présence datée');
  if((source.exceptions||[]).some(r=>payTrue_(r.Active)&&inMonth(r)&&(r.MoniteurID===id||r.RemplacantID===id)))reasons.push('Absence ou remplacement');
  if(row.actual||row.changed||row.absent||row.replacement)reasons.push('Heures');
  if((source.adjustments||[]).some(r=>r.MoniteurID===id&&payTrue_(r.Active)&&inMonth(r)))reasons.push('Correction');
  if((source.payments||[]).some(r=>r.MoniteurID===id&&r.Mois===month&&payTrue_(r.Active)))reasons.push('Versement');
  if(row.balance!==null&&row.balance!==undefined&&row.balance!==0)reasons.push('Solde');
  if(row.closed)reasons.push('Décompte clôturé');
  if((sessions||[]).some(r=>r.MoniteurID===id&&payTrue_(r.Active)&&inMonth(r)))reasons.push('Séance');
  if((declarations||[]).some(r=>r.monitorId===id&&r.month===month&&((r.lines||[]).length||r.status==='SUBMITTED'||r.status==='APPROVED'||r.firstSubmittedAt||r.submittedAt)))reasons.push('Fiche de prestation');
  return {actionable:reasons.length>0,activityReasons:reasons};
}
function payrollReport_(month){
  authorize_();payMonth_(month);const source=managementSources_(),result=calculatePayroll_(source,month),closed=privateRows_('CLOTURES'),preferences=privateRows_('PAYROLL_PREFERENCES'),sessions=sportRows_('SEANCES'),declarations=managementDeclarations_(month);
  result.revision=revision_(source);result.today=Utilities.formatDate(new Date(),TZ,'yyyy-MM-dd');result.bookUrl=privateBook_().getUrl();
  for(let i=0;i<result.rows.length;i++){const r=result.rows[i],saved=closed.filter(c=>c.MoniteurID===r.id&&c.Mois===month&&payTrue_(c.Active));if(saved.length>1)throw new Error('Plusieurs clôtures actives');
    if(saved.length){const frozen=JSON.parse(saved[0].DonneesJSON);result.rows[i]={...frozen,paid:r.paid,balance:frozen.due-r.paid,closed:true,closedAt:saved[0].ValideLe,closureId:saved[0].ClotureID};}
    const preference=payrollPreference_(r.id,preferences),activity=payrollActivity_(result.rows[i],source,month,sessions,declarations);Object.assign(result.rows[i],activity,{standby:preference.standby,standbyRevision:preference.revision,effectiveStandby:preference.standby&&!activity.actionable});
  }
  return result;
}
function loadMonitorDossier_(mid,month){
  authorize_();payMonth_(month);const team=loadTeam_(),person=team.rows.find(r=>r.MoniteurID===mid);if(!person)throw new Error('Moniteur introuvable');
  const own=r=>r.MoniteurID===mid,filter=(table,predicate)=>({...table,rows:table.rows.filter(predicate)}),report=payrollReport_(month),contracts=loadContracts_(),documents=privateLoad_('DOCUMENTS'),sessions=loadSport_('SEANCES');
  return {person,month,teamRevision:team.revision,monitors:team.rows,activities:team.activities,
    weekly:filter(loadTable_('HORAIRES'),own),presences:filter(loadTable_('PRESENCES'),own),exceptions:filter(loadTable_('EXCEPTIONS'),r=>own(r)||r.RemplacantID===mid),
    payroll:{row:report.rows.find(r=>r.id===mid),revision:report.revision},
    rates:filter(privateLoad_('REMUNERATIONS'),own),adjustments:filter(privateLoad_('AJUSTEMENTS'),own),payments:filter(privateLoad_('PAIEMENTS'),own),
    documents:filter(documents,own),contracts:{...filter(contracts,own),signatureStates:Object.fromEntries(contracts.rows.filter(own).map(r=>[r.DocumentID,contracts.signatureStates[r.DocumentID]]))},sessions:filter(sessions,own)};
}
function hasClosure_(mid,month){return privateRows_('CLOTURES').some(c=>c.MoniteurID===mid&&c.Mois===month&&payTrue_(c.Active));}
function requireMonitor_(id){if(!teamRows_().some(m=>m.MoniteurID===id))throw new Error('Moniteur introuvable');}
function saveManagementRow_(name,payload,revision){
  authorize_();if(!['REMUNERATIONS','AJUSTEMENTS','PAIEMENTS'].includes(name))throw new Error('Modification non autorisée');
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    const all=privateRows_(name);if(revision_(all)!==revision)throw new Error('Le tableau a changé. Recharge-le.');
    const key=PRIVATE_TABLES[name][0],before=all.find(r=>r[key]===payload[key]);if(payload[key]&&!before)throw new Error('Élément introuvable');
    let row=Object.fromEntries(PRIVATE_TABLES[name].map(h=>[h,payload[h]??before?.[h]??'']));row[key]=before?before[key]:Utilities.getUuid();requireMonitor_(row.MoniteurID);
    if(before&&row.MoniteurID!==before.MoniteurID)throw new Error('Le moniteur d’une écriture existante ne peut pas être changé.');
    if(name==='REMUNERATIONS'){
      payMonth_(row.Mois);if(hasClosure_(row.MoniteurID,row.Mois)||before&&hasClosure_(before.MoniteurID,before.Mois))throw new Error('Mois clôturé : rouvrir avant modification.');
      if(all.some(r=>r.FicheID!==row.FicheID&&r.MoniteurID===row.MoniteurID&&r.Mois===row.Mois))throw new Error('Une fiche existe déjà pour ce moniteur et ce mois.');
      row.Statut=safeText_(row.Statut);row.Activite=safeText_(row.Activite);
      row.PrixHeure=payNumber_(row.PrixHeure,0,1000,'Prix horaire');
      for(const h of ['RetenuePct','ChargePct'])row[h]=row[h]===''?'':payNumber_(row[h],0,100,h==='RetenuePct'?'Retenue':'Charge employeur');
      row.CotisationsValidees=payTrue_(row.CotisationsValidees);
      if(row.CotisationsValidees&&(row.RetenuePct===''||row.ChargePct===''))throw new Error('Précise les deux taux, même s’ils valent zéro.');
    }else{
      payDate_(row.Date);row.Active=payTrue_(row.Active);
      if(name==='AJUSTEMENTS'){
        if(hasClosure_(row.MoniteurID,row.Date.slice(0,7))||before&&hasClosure_(before.MoniteurID,before.Date.slice(0,7)))throw new Error('Mois clôturé : rouvrir avant correction.');
        row.Minutes=payNumber_(row.Minutes,-1440,1440,'Minutes');if(!Number.isInteger(row.Minutes)||!row.Minutes||!String(row.Motif).trim())throw new Error('Minutes entières non nulles et motif requis');row.Motif=safeText_(row.Motif);
      }else{
        payMonth_(row.Mois);row.Montant=payNumber_(row.Montant,0.01,1000000,'Montant');row.Montant=payCents_(row.Montant)/100;
        if(row.Date>Utilities.formatDate(new Date(),TZ,'yyyy-MM-dd'))throw new Error('Un paiement effectué ne peut pas avoir une date future.');
        if(!['VIREMENT','ESPECES','AUTRE'].includes(row.Mode))throw new Error('Moyen de paiement requis');for(const h of ['Reference','Note'])row[h]=safeText_(row[h]);
        if(!before&&all.some(p=>payTrue_(p.Active)&&p.MoniteurID===row.MoniteurID&&p.Mois===row.Mois&&p.Date===row.Date&&Number(p.Montant)===row.Montant&&p.Reference===row.Reference))throw new Error('Ce versement semble déjà enregistré. Vérifie la liste.');
      }
    }
    privateWrite_(name,row,before?'MODIFIER':'CREER',before);return privateLoad_(name);
  }finally{lock.releaseLock();}
}
function closePayroll_(month,mid,revision){
  authorize_();const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{payMonth_(month);if(month>=Utilities.formatDate(new Date(),TZ,'yyyy-MM'))throw new Error('Attends la fin du mois pour valider les heures réellement prestées.');
    const source=managementSources_();if(revision_(source)!==revision)throw new Error('Le décompte a changé. Actualise avant validation.');if(hasClosure_(mid,month))throw new Error('Décompte déjà clôturé');
    const report=calculatePayroll_(source,month).rows.find(r=>r.id===mid);if(!report||report.due===null||report.actual<0)throw new Error('Complète le tarif, les cotisations et les heures avant validation.');
    const row={ClotureID:Utilities.getUuid(),MoniteurID:mid,Mois:month,DonneesJSON:JSON.stringify(report),SourceRevision:revision,ValideLe:auditStamp_(),ValidePar:authorize_(),Active:true,ReouvertureMotif:''};privateWrite_('CLOTURES',row,'CLOTURER');return payrollReport_(month);
  }finally{lock.releaseLock();}
}
function reopenPayroll_(id,reason){authorize_();if(!String(reason||'').trim())throw new Error('Motif de réouverture requis');const lock=LockService.getScriptLock();lock.waitLock(10000);try{const before=privateRows_('CLOTURES').find(c=>c.ClotureID===id&&payTrue_(c.Active));if(!before)throw new Error('Clôture introuvable');privateWrite_('CLOTURES',{...before,Active:false,ReouvertureMotif:safeText_(reason)},'ROUVRIR',before);return payrollReport_(before.Mois);}finally{lock.releaseLock();}}
function archiveSchedule_(name,id,revision){
  authorize_();if(!['HORAIRES','PRESENCES','EXCEPTIONS'].includes(name))throw new Error('Planning uniquement');const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{const sheet=table_(name),all=rows_(sheet);if(revision_(all)!==revision)throw new Error('Le planning a changé. Actualise.');const key=sheet.getRange(1,1).getValue(),row=all.find(r=>r[key]===id);if(!row)throw new Error('Horaire introuvable');
    // Sauvegarde privée avant le retrait ; une interruption ne perd jamais l'horaire.
    const existing=privateRows_('ARCHIVES').find(a=>a.TableSource===name&&a.CleSource===id&&payTrue_(a.Active));
    if(existing&&existing.DonneesJSON!==JSON.stringify(row))throw new Error('Une ancienne archive existe pour cet horaire. Restaure-la avant de recommencer.');
    if(!existing)privateWrite_('ARCHIVES',{ArchiveID:Utilities.getUuid(),TableSource:name,CleSource:id,DonneesJSON:JSON.stringify(row),ArchiveLe:auditStamp_(),ArchivePar:authorize_(),Active:true},'ARCHIVER');
    const at=sheet.getRange(2,1,sheet.getLastRow()-1,1).getValues().findIndex(r=>r[0]===id)+2;sheet.getRange(at,1,1,sheet.getLastColumn()).clearContent();SpreadsheetApp.flush();return loadTable_(name);
  }finally{lock.releaseLock();}
}
function restoreSchedule_(id,revision){authorize_();const lock=LockService.getScriptLock();lock.waitLock(10000);try{const all=privateRows_('ARCHIVES');if(revision_(all)!==revision)throw new Error('Les archives ont changé. Actualise.');const a=all.find(r=>r.ArchiveID===id&&payTrue_(r.Active));if(!a||!['HORAIRES','PRESENCES','EXCEPTIONS'].includes(a.TableSource))throw new Error('Archive introuvable');const sheet=table_(a.TableSource),row=JSON.parse(a.DonneesJSON),headers=sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0],current=rows_(sheet).find(r=>r[headers[0]]===a.CleSource);
  if(current&&JSON.stringify(current)!==a.DonneesJSON)throw new Error('Un horaire différent porte déjà cet identifiant. Aucune donnée écrasée.');
  if(!current){const next=sheet.getLastRow()+1;extendTable_(sheet,next);sheet.getRange(next,1,1,headers.length).setValues([headers.map(h=>cell_(a.TableSource,h,row[h]))]);SpreadsheetApp.flush();}
  privateWrite_('ARCHIVES',{...a,Active:false},'RESTAURER',a);return privateLoad_('ARCHIVES');
}finally{lock.releaseLock();}}
function monitorDocumentFolder_(mid){requireMonitor_(mid);const props=PropertiesService.getScriptProperties();let root=props.getProperty('PRIVATE_CONTRACT_FOLDER');if(!root){root=DriveApp.createFolder('Atout Sport ASBL — Documents privés moniteurs').getId();props.setProperty('PRIVATE_CONTRACT_FOLDER',root);}const parent=DriveApp.getFolderById(root),name='Moniteur-'+mid,found=parent.getFoldersByName(name);return found.hasNext()?found.next():parent.createFolder(name);}
function uploadMonitorDocument_(payload,metadata,revision){
  authorize_();const allowed={'application/pdf':'pdf','image/jpeg':'jpg','image/png':'png','application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx'};
  if(!allowed[payload.type]||typeof payload.data!=='string'||payload.data.length>14000000)throw new Error('PDF, DOCX, JPG ou PNG, 10 Mo maximum');
  requireMonitor_(metadata.MoniteurID);if(!String(metadata.Titre||'').trim())throw new Error('Titre requis');
  if(!['CONTRAT','ATTESTATION','AUTRE'].includes(metadata.Type))throw new Error('Type de document requis');
  for(const key of ['DateDocument','DateFin'])if(metadata[key])payDate_(metadata[key]);
  if(metadata.DateDocument&&metadata.DateFin&&metadata.DateFin<metadata.DateDocument)throw new Error('La fin précède la date du document');
  const bytes=Utilities.base64Decode(payload.data);if(bytes.length>10*1024*1024)throw new Error('Fichier trop lourd');
  const b=bytes.map(v=>(v+256)%256),signatures={'application/pdf':[37,80,68,70],'image/jpeg':[255,216,255],'image/png':[137,80,78,71,13,10,26,10],'application/vnd.openxmlformats-officedocument.wordprocessingml.document':[80,75,3,4]};
  if(!signatures[payload.type].every((v,i)=>b[i]===v))throw new Error('Le contenu du fichier ne correspond pas à son format');
  const lock=LockService.getScriptLock();lock.waitLock(10000);let file;
  try{const all=privateRows_('DOCUMENTS');if(revision_(all)!==revision)throw new Error('La liste a changé. Actualise avant de réimporter.');
    const name=String(payload.name||'document').replace(/[^a-zA-Z0-9._-]/g,'_');file=monitorDocumentFolder_(metadata.MoniteurID).createFile(Utilities.newBlob(bytes,payload.type,Utilities.getUuid()+'-'+name));
    const row={DocumentID:Utilities.getUuid(),MoniteurID:metadata.MoniteurID,Titre:safeText_(metadata.Titre),Type:metadata.Type,FichierID:file.getId(),DateDocument:metadata.DateDocument||'',DateFin:metadata.DateFin||'',Active:true,CreeLe:auditStamp_()};privateWrite_('DOCUMENTS',row,'IMPORTER');return {...privateLoad_('DOCUMENTS'),createdDocumentId:row.DocumentID};
  }catch(e){if(file)try{file.setTrashed(true)}catch(ignored){}throw e;}finally{lock.releaseLock();}
}
function archiveDocument_(id,active,revision){authorize_();const lock=LockService.getScriptLock();lock.waitLock(10000);try{const rows=privateRows_('DOCUMENTS');if(revision_(rows)!==revision)throw new Error('La liste a changé. Actualise.');const before=rows.find(r=>r.DocumentID===id);if(!before)throw new Error('Document introuvable');privateWrite_('DOCUMENTS',{...before,Active:active===true},active?'RESTAURER':'ARCHIVER',before);return privateLoad_('DOCUMENTS');}finally{lock.releaseLock();}}
function openMonitorDocument_(id){authorize_();const r=privateRows_('DOCUMENTS').find(r=>r.DocumentID===id);if(!r)throw new Error('Document introuvable');return {url:DriveApp.getFileById(r.FichierID).getUrl()};}

/* Contrats étudiants : brouillons privés, sans signature automatique. */
const CONTRACT_MODEL_VERSION='2026-11-17.3';
function contractText_(value,max=500){const s=String(value||'').trim();if(s.length>max)throw new Error('Un champ dépasse '+max+' caractères.');return s;}
function contractEscape_(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function contractMinutes_(s){if(!/^\d{2}:\d{2}$/.test(s)||Number(s.slice(0,2))>23||Number(s.slice(3))>59)throw new Error('Heure invalide');return Number(s.slice(0,2))*60+Number(s.slice(3));}
function contractHours_(minutes){return Math.floor(minutes/60)+' h '+String(minutes%60).padStart(2,'0');}
function contractSchedule_(rows){
 if(!Array.isArray(rows)||!rows.length||rows.length>14)throw new Error('Ajoutez entre 1 et 14 créneaux.');
 const days=['Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi','Dimanche'],seen=[];
 return rows.map(r=>{if(!days.includes(r.day))throw new Error('Jour invalide');const a=contractMinutes_(r.start),b=contractMinutes_(r.end);if(b<=a)throw new Error('La fin doit suivre le début du créneau.');
 if(seen.some(x=>x.day===r.day&&a<x.b&&b>x.a))throw new Error('Deux créneaux se chevauchent.');seen.push({day:r.day,a,b});let pause=0;
 if(r.pauseStart||r.pauseEnd){const x=contractMinutes_(r.pauseStart),y=contractMinutes_(r.pauseEnd);if(x<a||y>b||y<=x)throw new Error('La pause doit être comprise dans le créneau.');pause=y-x;}
 return {day:r.day,start:r.start,end:r.end,pauseStart:r.pauseStart||'',pauseEnd:r.pauseEnd||'',minutes:b-a-pause};}).sort((a,b)=>days.indexOf(a.day)-days.indexOf(b.day)||a.start.localeCompare(b.start));
}
// Point d'adaptation injecté par le portail. La source autonome ne reprend
// jamais un ancien numéro mémorisé comme s'il avait été approuvé.
function contractApprovedNiss_(mid){return pIdentityApprovedNiss_(mid);}
function contractProfile_(mid){const raw=PropertiesService.getScriptProperties().getProperty('CONTRACT_PROFILE_'+mid),profile=raw?JSON.parse(raw):{};delete profile.niss;return profile;}
function contractDraft_(mid){const rows=privateRows_('CONTRACT_DRAFTS').filter(r=>r.MoniteurID===mid);if(rows.length>1)throw new Error('Plusieurs brouillons pour ce moniteur.');return rows[0]||null;}
function loadContractForm_(mid){return contractForm_(mid);}
function contractForm_(mid,draftOverride){
 authorize_();const m=teamRows_().find(r=>r.MoniteurID===mid),props=PropertiesService.getScriptProperties();if(!m)throw new Error('Moniteur introuvable.');
 let shared={employer:'',employerAddress:'',representative:'',workplaces:'',functionName:'Professeur de natation',paymentTerms:'Au maximum le 15 du mois suivant, par virement bancaire.',travel:'À confirmer selon les dispositions applicables.',absenceContact:'',signedPlace:'',housing:'Aucun logement fourni par l’employeur.',commission:'',workRules:''};
 const saved=props.getProperty('CONTRACT_EMPLOYER');if(saved){const oldShared=JSON.parse(saved);for(const k of ['functionName','workplaces'])delete oldShared[k];shared={...shared,...oldShared};}if(!m.Secteurs.includes('PISCINE')){shared.functionName=m.Secteurs.includes('STAGE')?'Moniteur de stage':'Animateur extrasport';shared.workplaces='';}
 const weekly=rows_(table_('HORAIRES')).filter(r=>r.MoniteurID===mid&&payTrue_(r.Actif));const unique=new Map();for(const r of weekly)unique.set([r.JourSemaine,r.HeureDebut,r.HeureFin].join('|'),{day:r.JourSemaine,start:r.HeureDebut,end:r.HeureFin,pauseStart:'',pauseEnd:''});
 const profile=contractProfile_(mid),approvedNiss=contractApprovedNiss_(mid);const month=Utilities.formatDate(new Date(),TZ,'yyyy-MM');const rate=privateRows_('REMUNERATIONS').find(r=>r.MoniteurID===mid&&r.Mois===month)?.PrixHeure,draftRow=draftOverride===undefined?contractDraft_(mid):draftOverride,draft=draftRow?JSON.parse(draftRow.DonneesJSON):{};
 return {sectors:m.Secteurs,activities:SPORT_ACTIVITIES,identity:{nissApproved:!!approvedNiss},draft:{exists:!!draftRow,savedAt:draftRow?.ModifieLe||''},monthlyRate:{month,value:rate??null},profile:{contractType:['ETUDIANT','ART17','BENEVOLE'].includes(m.Statut)?m.Statut:'ETUDIANT',sector:m.Secteurs.includes('PISCINE')?'PISCINE':m.Secteurs[0],activity:m.Secteurs.includes('PISCINE')?'Natation':m.Secteurs.includes('STAGE')?'Multisports':'Éveil sportif',duties:'Assurer les cours de natation selon les objectifs et le niveau des enfants. Respecter l’approche pédagogique et ludique de l’ASBL.',...shared,fullName:[m.Nom,m.Prenom].filter(Boolean).join(' '),birthDate:m.DateNaissance||'',address:'',iban:'',rate:rate??'',schedule:[...unique.values()],...profile,...(!m.Secteurs.includes('PISCINE')&&!profile.duties?{duties:'Accueillir les enfants, préparer les activités, vérifier les présences et veiller à la sécurité du groupe.'}:{}),fullName:[m.Nom,m.Prenom].filter(Boolean).join(' '),birthDate:m.DateNaissance||profile.birthDate||'',address:m.Adresse||'',startDate:'',endDate:'',signedDate:Utilities.formatDate(new Date(),TZ,'yyyy-MM-dd'),...draft,niss:approvedNiss,MoniteurID:mid},revision:revision_({shared,profile,person:m,approvedNiss,rate:rate??null,weekly:[...unique.values()],draftRow})};
}
// Enregistrer une préparation incomplète ne crée ni PDF, ni signature, ni salaire.
function saveContractDraft_(payload,revision){
 authorize_();if(!payload||typeof payload!=='object')throw new Error('Fiche contrat attendue.');const mid=String(payload.MoniteurID||'');requireMonitor_(mid);const lock=LockService.getScriptLock();lock.waitLock(10000);
 try{const fresh=loadContractForm_(mid);if(fresh.revision!==revision)throw new Error('La fiche contrat a changé. Fermez puis rechargez le formulaire.');const before=contractDraft_(mid),draft={},fields=['contractType','sector','activity','duties','insurance','volunteerTerms','employer','employerAddress','representative','fullName','birthDate','address','iban','functionName','workplaces','paymentTerms','travel','absenceContact','commission','workRules','housing','signedPlace','signedDate','startDate','endDate'];
 for(const k of fields)draft[k]=contractText_(Object.prototype.hasOwnProperty.call(payload,k)?payload[k]:fresh.profile[k],['workRules','workplaces'].includes(k)?1200:500);
 if(draft.contractType&&!['ETUDIANT','ART17','BENEVOLE'].includes(draft.contractType))throw new Error('Type de contrat incorrect.');
 if(draft.sector&&!fresh.sectors.includes(draft.sector))throw new Error('Fonction incompatible avec le secteur.');
 for(const k of ['signedDate','startDate','endDate'])if(draft[k])payDate_(draft[k]);
 if(draft.startDate&&draft.endDate&&draft.endDate<draft.startDate)throw new Error('La fin du contrat précède son début.');
 if(draft.birthDate&&(!/^(19|20)\d{2}-\d{2}-\d{2}$/.test(draft.birthDate)||!Number.isFinite(+new Date(draft.birthDate+'T00:00:00Z'))||new Date(draft.birthDate+'T00:00:00Z').toISOString().slice(0,10)!==draft.birthDate))throw new Error('Date de naissance invalide.');
 const rate=Object.prototype.hasOwnProperty.call(payload,'rate')?payload.rate:fresh.profile.rate;draft.rate=String(rate??'').trim()===''?'':payNumber_(rate,0,1000,'Rémunération brute horaire');
 const schedule=Object.prototype.hasOwnProperty.call(payload,'schedule')?payload.schedule:fresh.profile.schedule;if(!Array.isArray(schedule)||schedule.length>14)throw new Error('14 créneaux maximum.');
 draft.schedule=schedule.map(raw=>{if(!raw||typeof raw!=='object')throw new Error('Créneau incorrect.');const r={};for(const k of ['day','start','end','pauseStart','pauseEnd'])r[k]=contractText_(raw[k],20);if(r.day&&!DAYS.includes(r.day))throw new Error('Jour invalide');for(const k of ['start','end','pauseStart','pauseEnd'])if(r[k])contractMinutes_(r[k]);return r;});
 const row={MoniteurID:mid,DonneesJSON:JSON.stringify(draft),ModifieLe:auditStamp_(),ModifiePar:authorize_()};if(row.DonneesJSON.length>30000)throw new Error('Brouillon trop volumineux.');privateWrite_('CONTRACT_DRAFTS',row,'ENREGISTRER_BROUILLON_CONTRAT',before);
 // Le REST write ne doit pas être relu depuis un cache SpreadsheetApp ancien.
 return {...contractForm_(mid,row),saved:true,message:'Brouillon enregistré. Aucun PDF ni décompte modifié.'};
 }finally{lock.releaseLock();}
}
function normaliseContract_(p){
 const fields=['MoniteurID','contractType','sector','activity','duties','insurance','volunteerTerms','employer','employerAddress','representative','fullName','birthDate','address','niss','iban','functionName','workplaces','paymentTerms','travel','absenceContact','commission','workRules','housing','signedPlace','signedDate','startDate','endDate'];
 const c=Object.fromEntries(fields.map(k=>[k,contractText_(p[k],['workRules','workplaces'].includes(k)?1200:500)]));
 for(const k of ['MoniteurID','contractType','sector','activity','duties','employer','employerAddress','representative','fullName','birthDate','address','functionName','workplaces','paymentTerms','signedPlace','signedDate','startDate','endDate'])if(!c[k])throw new Error('Champ obligatoire manquant : '+k);
 for(const k of ['signedDate','startDate','endDate'])payDate_(c[k]);if(!/^(19|20)\d{2}-\d{2}-\d{2}$/.test(c.birthDate)||!Number.isFinite(+new Date(c.birthDate+'T00:00:00Z'))||new Date(c.birthDate+'T00:00:00Z').toISOString().slice(0,10)!==c.birthDate)throw new Error('Date de naissance invalide.');if(c.endDate<c.startDate)throw new Error('La fin du contrat précède son début.');if(c.birthDate>=c.startDate)throw new Error('Date de naissance incohérente.');
 if(!['ETUDIANT','ART17','BENEVOLE'].includes(c.contractType))throw new Error('Type de contrat incorrect.');
 if(!SPORT_ACTIVITIES[c.sector])throw new Error('Choisissez le secteur du contrat.');const member=teamRows_().find(m=>m.MoniteurID===c.MoniteurID);if(!member||!member.Secteurs.includes(c.sector))throw new Error('Fonction incompatible avec le secteur.');if(!c.duties)throw new Error('Précisez les missions.');
 c.rate=c.contractType==='BENEVOLE'?0:payNumber_(p.rate,.01,1000,'Rémunération brute horaire');c.schedule=contractSchedule_(p.schedule);c.weeklyMinutes=c.schedule.reduce((s,r)=>s+r.minutes,0);c.remember=p.remember===true;c.validated=p.validated===true&&c.contractType!=='BENEVOLE';c.employerSigned=c.validated&&p.employerSigned===true;if(c.employerSigned&&!employerSignature_())throw new Error('Signature employeur non configurée.');c.modelVersion=CONTRACT_MODEL_VERSION;if(c.validated&&(!c.commission||!c.workRules||!c.travel))throw new Error('Complétez la commission paritaire, les références du règlement et les frais de déplacement avant de produire une version à signer.');
 if(c.iban&&!/^[A-Z]{2}[0-9A-Z]{13,32}$/.test(c.iban.replace(/\s/g,'').toUpperCase()))throw new Error('Format IBAN invalide.');
 const approvedNiss=contractApprovedNiss_(c.MoniteurID),providedNiss=c.niss.replace(/[.\-\s]/g,'');
 if(providedNiss&&providedNiss!==approvedNiss)throw new Error('Le numéro national du contrat doit correspondre à celui approuvé dans la fiche identité du moniteur. Actualisez le formulaire après validation.');
 c.niss=approvedNiss;
 return c;
}
function contractHtml_(c){
 const e=contractEscape_,show=v=>e(v||'À compléter'),d=v=>v?v.split('-').reverse().join('/'):'À compléter',p=v=>show(v).replace(/\n/g,'<br>'),vol=c.contractType==='BENEVOLE',art=c.contractType==='ART17';
 const title=vol?'CONVENTION DE VOLONTARIAT':art?'CONTRAT D’OCCUPATION À DURÉE DÉTERMINÉE — ARTICLE 17':'CONTRAT DE TRAVAIL ÉTUDIANT';
 const worker=vol?'le volontaire':art?'le travailleur':'l’étudiant';
 const label=vol?'BROUILLON — Modèle bénévole de l’ASBL attendu. Ce document n’est pas prêt à signer.':c.validated?(c.employerSigned?'Signature employeur apposée · Signature du moniteur attendue.':'Document non signé · À relire et signer par les deux parties.'):'BROUILLON — Informations et modèle à vérifier avant signature.';
 const schedule=c.schedule.map(r=>'<tr><td>'+e(r.day)+'</td><td>'+e(r.start)+' – '+e(r.end)+'</td><td>'+e(r.pauseStart?r.pauseStart+' – '+r.pauseEnd:'Aucune')+'</td><td>'+contractHours_(r.minutes)+'</td></tr>').join('');
 const brand='<header><img src="'+sportLogo_()+'" alt="Atout Sport"><div><b>'+show(c.employer)+'</b><br><small>'+show(c.employerAddress)+'</small></div></header>';
 const css='@page{size:A4;margin:15mm 17mm}body{font:10.2pt Arial,sans-serif;color:#171e24;line-height:1.4;margin:0}header{display:table;width:100%;margin-bottom:5mm}header img{width:25mm;height:17mm;object-fit:contain;vertical-align:middle}header div{display:inline-block;vertical-align:middle;margin-left:4mm;font-size:12pt}header small{font-size:8.5pt;color:#56646b}h1{border:1px solid #343d41;padding:3mm;text-align:center;font-size:12pt;line-height:1.3;margin:0 0 3mm}h2{font-size:10.6pt;text-decoration:underline;margin:4mm 0 2mm;break-after:avoid}p{margin:2.5mm 0}table{width:100%;border-collapse:collapse;font-size:9.5pt}td,th{text-align:left;border-bottom:1px solid #ced5d8;padding:2mm}thead{display:table-header-group}tr{break-inside:avoid}.draft{font-size:8.2pt;color:#4e5a60;margin:2mm 0 4mm}.page{page-break-after:always}.page:last-child{page-break-after:auto}.sign{margin-top:7mm;break-inside:avoid}.sign td{width:50%;vertical-align:top;border:0;padding:0 4mm 0 0}.signature{width:60mm;height:34mm;object-fit:contain}.blank{height:30mm}.foot{font-size:8pt;color:#657077;margin-top:6mm}';
 let html='<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>'+css+'</style></head><body><section class="page">'+brand+'<h1>'+title+'</h1><div class="draft">'+label+'</div>';
 html+='<p><strong>Entre</strong></p><p>D’une part, <strong>'+show(c.employer)+'</strong>, '+show(c.employerAddress)+', représentée par '+show(c.representative)+', ci-après « '+(vol?'l’association':'l’employeur')+' ».</p><p><strong>Et</strong></p><p>D’autre part, <strong>'+show(c.fullName)+'</strong>, né(e) le '+d(c.birthDate)+', domicilié(e) '+show(c.address)+', ci-après « '+worker+' ».</p>'+(vol?'':'<p>NISS : '+show(c.niss)+'</p>')+'<p><strong>Il est convenu ce qui suit :</strong></p>';
 html+='<h2>Article 1 : Objet et durée</h2><p>'+ (vol?'L’association propose une mission volontaire':'Le travailleur est engagé '+(art?'dans le cadre d’un contrat à durée déterminée à temps partiel, sous le régime de l’article 17 de l’arrêté royal du 28 novembre 1969':'en tant qu’étudiant'))+' du <strong>'+d(c.startDate)+'</strong> au <strong>'+d(c.endDate)+'</strong> inclus.</p><p>Fonction : <strong>'+show(c.functionName)+'</strong> · Activité : '+show(c.activity)+' ('+show(({PISCINE:'Piscine',STAGE:'Stages',EXTRASPORT:'Extrasport'})[c.sector])+').</p><p>'+p(c.duties)+'</p>';
 if(art)html+='<p>Le travailleur rend compte de ses activités à '+show(c.absenceContact)+'. Le contrat est régi par les dispositions applicables de la loi du 3 juillet 1978 et du régime article 17.</p>';
 html+='<h2>Article 2 : Lieu '+(vol?'de la mission':'de travail')+'</h2><p>'+p(c.workplaces)+'</p><h2>Article 3 : '+(vol?'Organisation de la mission':'Durée du travail')+'</h2><p>'+ (vol?'Créneaux convenus à titre d’organisation de la mission':'Régime fixe : '+contractHours_(c.weeklyMinutes)+' par semaine, hors pauses')+'.</p><table><thead><tr><th>Jour</th><th>Horaire</th><th>Pause</th><th>Durée</th></tr></thead><tbody>'+schedule+'</tbody></table>';
 if(!vol)html+='<p>Les jours sans prestation indiquée constituent les jours d’arrêt régulier, sous réserve des dispositions applicables et des modifications convenues par écrit.</p>';
 html+='<div class="foot">'+show(c.fullName)+' · '+d(c.startDate)+' — '+d(c.endDate)+'</div></section><section class="page">'+brand;
 if(vol){html+='<h2>Article 4 : Caractère volontaire et frais</h2><p>La mission est exercée librement, sans rémunération ni obligation, dans le cadre de la loi du 3 juillet 2005 relative aux droits des volontaires.</p><p>Modalités de remboursement des frais : '+p(c.volunteerTerms)+'</p><h2>Article 5 : Assurance et responsabilité</h2><p>'+p(c.insurance)+'</p><h2>Article 6 : Organisation et confidentialité</h2><p>Référent : '+show(c.absenceContact)+'. Les informations concernant les enfants et leurs familles sont traitées confidentiellement. Les consignes d’encadrement et de sécurité sont communiquées avant la mission.</p><h2>Article 7 : Règlement et fin de la mission</h2><p>'+p(c.workRules)+'</p><p>Les modalités pratiques et les conditions de cessation de la mission seront précisées dans le modèle bénévole de l’association.</p>';
 }else{html+='<h2>Article 4 : Rémunération</h2><p>La rémunération brute est fixée à <strong>'+Number(c.rate).toFixed(2).replace('.',',')+' euros par heure</strong>. La rémunération est protégée conformément à la loi du 12 avril 1965 et ses arrêtés d’exécution.</p><p>Commission paritaire compétente : '+show(c.commission)+'.</p><h2>Article 5 : Paiement de la rémunération</h2><p>'+p(c.paymentTerms)+'</p><p>Compte personnel (IBAN) : '+show(c.iban)+'.</p><h2>Article 6 : Frais de déplacement</h2><p>'+p(c.travel)+'</p><h2>Article 7 : Absences et suspensions</h2><p>En cas d’incapacité, '+worker+' avertit immédiatement '+show(c.absenceContact)+'. Les justificatifs et le contrôle médical sont soumis à la législation et au règlement de travail applicable.</p><h2>Article 8 : Règlement de travail et dispositions finales</h2><p>Le travailleur reçoit un exemplaire de ce contrat et du règlement de travail. Références aux modalités de secours, aux représentants, au service de prévention et au Contrôle des lois sociales compétent :</p><p>'+p(c.workRules)+'</p><p>Logement éventuel : '+p(c.housing)+'</p>';
 if(!art)html+='<p>Les trois premiers jours de travail effectivement prévus constituent la période d’essai. Chaque partie peut y mettre fin sans préavis ni indemnité dans les conditions légales.</p>';
 html+='<p>Tout litige relève des juridictions légalement compétentes.</p>';
 }
 html+='<p>Établi en deux exemplaires, un pour chaque partie. Fait à '+show(c.signedPlace)+', le '+d(c.signedDate)+'.</p><table class="sign"><tr><td><strong>'+ (vol?'Le volontaire':art?'Le travailleur':'L’étudiant')+'</strong><br>Mention « Lu et approuvé »<div class="blank"></div>Signature</td><td><strong>'+ (vol?'L’association':'L’employeur')+'</strong><br>'+show(c.representative)+(c.employerSigned?'<br><img class="signature" src="'+employerSignature_()+'" alt="Lu et approuvé — signature employeur">':'<br>Mention « Lu et approuvé »<div class="blank"></div>Signature')+'</td></tr></table><div class="foot">'+label+' · Modèle '+e(CONTRACT_MODEL_VERSION)+'</div></section></body></html>';
 return html;
}
function previewStudentContract_(payload){authorize_();requireMonitor_(payload.MoniteurID);const c=normaliseContract_(payload);const html=contractHtml_(c),pdf=HtmlService.createHtmlOutput(html).getAs('application/pdf');return {html,weeklyMinutes:c.weeklyMinutes,pdf:Utilities.base64Encode(pdf.getBytes())};}
function generateStudentContract_(payload,revision){
 authorize_();const c=normaliseContract_(payload);requireMonitor_(c.MoniteurID);const lock=LockService.getScriptLock();lock.waitLock(10000);let file,committed=false;
 try{if(loadContractForm_(c.MoniteurID).revision!==revision)throw new Error('La fiche contrat a changé. Fermez puis rechargez le formulaire.');
 const previousDraft=contractDraft_(c.MoniteurID);if(previousDraft){const latest={...c};for(const key of ['MoniteurID','niss','remember','validated','employerSigned','weeklyMinutes','modelVersion'])delete latest[key];privateWrite_('CONTRACT_DRAFTS',{MoniteurID:c.MoniteurID,DonneesJSON:JSON.stringify(latest),ModifieLe:auditStamp_(),ModifiePar:authorize_()},'ACTUALISER_BROUILLON_AVANT_PDF',previousDraft);}
 const pdf=HtmlService.createHtmlOutput(contractHtml_(c)).getAs('application/pdf').setName((c.validated?'Contrat-':'BROUILLON-Contrat-')+c.MoniteurID+'-'+c.startDate+'-'+Utilities.getUuid().slice(0,8)+'.pdf');
 file=monitorDocumentFolder_(c.MoniteurID).createFile(pdf);const row={DocumentID:Utilities.getUuid(),MoniteurID:c.MoniteurID,Titre:(c.validated?'Contrat ':'Brouillon contrat ')+({ETUDIANT:'étudiant',ART17:'article 17',BENEVOLE:'bénévole'})[c.contractType]+' · '+c.startDate+' au '+c.endDate,Type:'CONTRAT',FichierID:file.getId(),DateDocument:c.signedDate,DateFin:c.endDate,Active:true,CreeLe:auditStamp_()};
 privateWrite_('DOCUMENTS',row,'GENERER_CONTRAT');committed=true;PropertiesService.getScriptProperties().setProperty('CONTRACT_STATUS_'+row.DocumentID,JSON.stringify({status:c.validated?'NON_SIGNE':'BROUILLON',contractType:c.contractType,startDate:c.startDate,endDate:c.endDate,sector:c.sector,employerSigned:c.employerSigned}));
 let remembered=false;if(c.remember){try{const props=PropertiesService.getScriptProperties(),profile={...c};for(const k of ['niss','startDate','endDate','signedDate','remember','validated','employerSigned','weeklyMinutes','modelVersion'])delete profile[k];props.setProperty('CONTRACT_PROFILE_'+c.MoniteurID,JSON.stringify(profile));const shared={};for(const k of ['employer','employerAddress','representative','paymentTerms','travel','absenceContact','commission','workRules','housing','signedPlace'])shared[k]=c[k];props.setProperty('CONTRACT_EMPLOYER',JSON.stringify(shared));const contact=sportRows_('EQUIPE_EXTRA').find(r=>r.MoniteurID===c.MoniteurID);if(contact&&contact.Adresse!==c.address)sportWrite_('EQUIPE_EXTRA',{...contact,Adresse:c.address,ModifieLe:auditStamp_()},'ADRESSE_DEPUIS_CONTRAT',contact);remembered=true;}catch(ignored){}}
 return {url:file.getUrl(),id:row.DocumentID,remembered,weeklyMinutes:c.weeklyMinutes};
 }catch(e){if(file&&!committed)try{file.setTrashed(true)}catch(ignored){}throw e;}finally{lock.releaseLock();}
}
function loadContracts_(){authorize_();const result=privateLoad_('DOCUMENTS'),props=PropertiesService.getScriptProperties();result.rows=result.rows.filter(r=>r.Type==='CONTRAT');result.signatureStates={};for(const r of result.rows){const raw=props.getProperty('CONTRACT_STATUS_'+r.DocumentID);result.signatureStates[r.DocumentID]=raw?JSON.parse(raw):{status:r.Titre.startsWith('Brouillon')?'BROUILLON':'NON_SIGNE'};}for(const [id,state]of Object.entries(result.signatureStates)){if(state.originalId&&state.status==='SIGNE'&&result.rows.some(r=>r.DocumentID===id&&payTrue_(r.Active)))result.signatureStates[state.originalId]={...result.signatureStates[state.originalId],status:'SIGNE',signedDate:state.signedDate,signedVersionId:id};}return result;}
function uploadSignedContract_(file,originalId,signedDate,revision){
 authorize_();payDate_(signedDate);if(signedDate>Utilities.formatDate(new Date(),TZ,'yyyy-MM-dd'))throw new Error('La date de signature ne peut pas être future.');if(file.type!=='application/pdf')throw new Error('Importez la version signée au format PDF.');
 const all=privateRows_('DOCUMENTS');if(revision_(all)!==revision)throw new Error('Les documents ont changé. Actualisez.');const original=all.find(r=>r.DocumentID===originalId&&r.Type==='CONTRAT');if(!original)throw new Error('Contrat introuvable.');
 const result=uploadMonitorDocument_(file,{MoniteurID:original.MoniteurID,Titre:'Signé — '+original.Titre.replace(/^Brouillon\s*/i,''),Type:'CONTRAT',DateDocument:signedDate,DateFin:original.DateFin||''},revision);
 PropertiesService.getScriptProperties().setProperty('CONTRACT_STATUS_'+result.createdDocumentId,JSON.stringify({...loadContracts_().signatureStates[originalId],status:'SIGNE',signedDate,originalId,declaredBy:authorize_()}));
 return loadContracts_();
}

/* Atout Sport ASBL : gestion privée des équipes et des inscriptions. */
const SPORT_TABLES={
 EQUIPE_EXTRA:['MoniteurID','Role','Statut','Activites','Nom','Prenom','DateNaissance','Photo','Email','Telephone','Actif','ModifieLe','Adresse'],
 SEANCES:['SeanceID','Secteur','Activite','Titre','Date','HeureDebut','HeureFin','MoniteurID','Lieu','Capacite','Active','Note'],
 ENFANTS:['EnfantID','Nom','Prenom','DateNaissance','Responsable','Contact','Actif'],
 INSCRIPTIONS:['InscriptionID','SeanceID','EnfantID','Statut','Note','Active'],
 SUIVI_MENSUEL:['SuiviID','MoniteurID','Mois','StatutFiche','DateLimite','DateReception','DocumentID','Note']
};
const SPORT_ROLES={MONITEUR:['PISCINE','STAGE','EXTRASPORT'],MONITEUR_STAGE:['STAGE'],RESPONSABLE:['PISCINE','STAGE','EXTRASPORT'],EXTRASPORT:['EXTRASPORT']};
const SPORT_ACTIVITIES={PISCINE:['Natation','Bébés nageurs','Aquagym'],STAGE:['Multisports','Éveil sportif','Psychomotricité','Cyclomotricité','Tennis','VTT','Danse / Hip-hop','Cuisine','Équitation','Sciences','Garderie'],EXTRASPORT:['Psychomotricité','Éveil sportif','Danse','Gestion administrative','Comptabilité','Mini-foot','Zumba kids','Jogging','Zumba','Body Balance','Coaching']};
function sportSheet_(name){if(!SPORT_TABLES[name])throw new Error('Section inconnue.');const s=privateBook_().getSheetByName(name);if(!s)throw new Error('Installation Atout Sport à terminer.');const headers=s.getRange(1,1,1,SPORT_TABLES[name].length).getValues()[0];if(JSON.stringify(headers)!==JSON.stringify(SPORT_TABLES[name]))throw new Error('Colonnes modifiées dans '+name);return s;}
function sportRows_(name){return rows_(sportSheet_(name));}
function sportWrite_(name,row,action,before){
 const sheet=sportSheet_(name),hs=SPORT_TABLES[name],key=hs[0],raw=sheet.getLastRow()>1?sheet.getRange(2,1,sheet.getLastRow()-1,1).getValues():[],index=raw.findIndex(r=>r[0]===row[key]);
 const target=index>=0?index+1:sheet.getLastRow(),journal=privateSheet_('JOURNAL'),audit={EvenementID:Utilities.getUuid(),Date:auditStamp_(),Compte:authorize_(),Action:action,Table:name,ElementID:row[key],AvantJSON:JSON.stringify(before||{}),ApresJSON:JSON.stringify(row)};
 const requests=[{updateCells:{range:{sheetId:sheet.getSheetId(),startRowIndex:target,endRowIndex:target+1,startColumnIndex:0,endColumnIndex:hs.length},rows:[{values:hs.map(h=>({userEnteredValue:privateValue_(row[h])}))}],fields:'userEnteredValue'}},{appendCells:{sheetId:journal.getSheetId(),rows:[{values:PRIVATE_TABLES.JOURNAL.map(h=>({userEnteredValue:privateValue_(audit[h])}))}],fields:'userEnteredValue'}}];
 if(target>=sheet.getMaxRows())requests.unshift({appendDimension:{sheetId:sheet.getSheetId(),dimension:'ROWS',length:100}});
 const res=UrlFetchApp.fetch('https://sheets.googleapis.com/v4/spreadsheets/'+MANAGEMENT_BOOK+':batchUpdate',{method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},payload:JSON.stringify({requests}),muteHttpExceptions:true});if(res.getResponseCode()>=300)throw new Error('Enregistrement impossible. Réessayez.');
}
function installSport_(){
 authorize_();const lock=LockService.getScriptLock();lock.waitLock(10000);
 try{const book=privateBook_();for(const [name,headers]of Object.entries(SPORT_TABLES)){let sheet=book.getSheetByName(name);if(!sheet){sheet=book.insertSheet(name);sheet.getRange(1,1,1,headers.length).setValues([headers]).setFontWeight('bold').setBackground('#123f50').setFontColor('#ffffff');sheet.setFrozenRows(1);sheet.setHiddenGridlines(true);sheet.setColumnWidths(1,headers.length,150);sheet.getRange(2,1,sheet.getMaxRows()-1,headers.length).setNumberFormat('@');}
 else {const oldHeaders=sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];if(JSON.stringify(oldHeaders)!==JSON.stringify(headers)){if(oldHeaders.length>=headers.length||oldHeaders.some((h,i)=>h!==headers[i]))throw new Error('Migration arrêtée : colonnes inattendues dans '+name);sheet.getRange(1,oldHeaders.length+1,1,headers.length-oldHeaders.length).setValues([headers.slice(oldHeaders.length)]).setFontWeight('bold').setBackground('#123f50').setFontColor('#ffffff');sheet.getRange(2,oldHeaders.length+1,sheet.getMaxRows()-1,headers.length-oldHeaders.length).setNumberFormat('@');
 if(name==='EQUIPE_EXTRA'&&!oldHeaders.includes('Adresse')&&sheet.getLastRow()>1){const ids=sheet.getRange(2,1,sheet.getLastRow()-1,1).getValues();const values=ids.map(r=>{let address='';try{address=contractProfile_(r[0]).address||'';}catch(ignored){}return [safeText_(String(address).slice(0,500))];});sheet.getRange(2,headers.indexOf('Adresse')+1,values.length,1).setValues(values);}
 }} }
 const existing=sportRows_('EQUIPE_EXTRA'),ids=new Set(existing.map(r=>r.MoniteurID));let count=0;
 for(const m of rows_(table_('MONITEURS'))){if(ids.has(m.MoniteurID))continue;const role=/responsable/i.test(m.Fonction)?'RESPONSABLE':'MONITEUR';sportWrite_('EQUIPE_EXTRA',{MoniteurID:m.MoniteurID,Role:role,Statut:'A_PRECISER',Activites:'',Actif:payTrue_(m.Actif),ModifieLe:auditStamp_()},'REPRENDRE_EQUIPE');count++;}
 return {added:count,total:teamRows_().length};
 }finally{lock.releaseLock();}
}
function teamRows_(pool,extra){
 pool=pool||rows_(table_('MONITEURS'));extra=extra||sportRows_('EQUIPE_EXTRA');const map=new Map(extra.map(r=>[r.MoniteurID,{...r,Pool:false,Fonction:r.Role,NomAffiche:r.Prenom,Secteurs:SPORT_ROLES[r.Role]||[]} ]));
 for(const m of pool){const profile=map.get(m.MoniteurID)||{Role:/responsable/i.test(m.Fonction)?'RESPONSABLE':'MONITEUR',Statut:'A_PRECISER',Activites:''};map.set(m.MoniteurID,{...profile,...m,Pool:true,Secteurs:SPORT_ROLES[profile.Role]||SPORT_ROLES.MONITEUR});}
 return [...map.values()].sort((a,b)=>String(a.Prenom).localeCompare(String(b.Prenom),'fr'));
}
function loadTeam_(){authorize_();const pool=rows_(table_('MONITEURS')),extra=sportRows_('EQUIPE_EXTRA');return {rows:teamRows_(pool,extra),revision:revision_({pool,extra}),activities:SPORT_ACTIVITIES};}
function sportId_(v){const s=String(v||'');if(s&&!/^[\w-]{3,100}$/.test(s))throw new Error('Identifiant incorrect');return s;}
function sportText_(v,max=500){return contractText_(v,max);}
function saveTeam_(p,revision){
 authorize_();const lock=LockService.getScriptLock();lock.waitLock(10000);
 try{const fresh=loadTeam_();if(fresh.revision!==revision)throw new Error('L’équipe a changé. Fermez puis rechargez.');let id=sportId_(p.MoniteurID),old=fresh.rows.find(m=>m.MoniteurID===id);if(id&&!old)throw new Error('Personne introuvable.');
 const role=p.Role;if(!SPORT_ROLES[role])throw new Error('Choisissez une fonction.');if(!['A_PRECISER','ETUDIANT','ART17','BENEVOLE','SOUS_TRAITANT','EMPLOYE','AUTRE'].includes(p.Statut))throw new Error('Statut incorrect.');
 const first=sportText_(p.Prenom,60),last=sportText_(p.Nom,80);if(!first||!last)throw new Error('Nom et prénom requis.');
 if(!id&&fresh.rows.some(m=>m.Prenom.trim().toLowerCase()===first.toLowerCase()&&m.Nom.trim().toLowerCase()===last.toLowerCase()))throw new Error('Cette personne existe déjà : modifiez sa fiche.');
 if(old?.Pool&&!SPORT_ROLES[role].includes('PISCINE'))throw new Error('Cette fiche est reliée au planning piscine. Retirez d’abord ses horaires et utilisez une migration contrôlée avant de la convertir en stage uniquement. Ses activités supplémentaires restent modifiables.');
 const activities=String(p.Activites||'').split(';').map(x=>x.trim()).filter(Boolean);if(activities.length>20||activities.some(x=>x.length>70))throw new Error('Liste d’activités trop longue.');
 const birth=sportText_(p.DateNaissance,10);if(birth&&(!/^\d{4}-\d{2}-\d{2}$/.test(birth)||isNaN(+new Date(birth+'T00:00Z'))||new Date(birth+'T00:00Z').toISOString().slice(0,10)!==birth||birth>Utilities.formatDate(new Date(),TZ,'yyyy-MM-dd')))throw new Error('Date de naissance incorrecte.');
 if(!id)id=Utilities.getUuid();const extra=sportRows_('EQUIPE_EXTRA').find(r=>r.MoniteurID===id),hasPool=old?.Pool||SPORT_ROLES[role].includes('PISCINE');
 const row={MoniteurID:id,Role:role,Statut:p.Statut,Activites:activities.join(';'),Nom:hasPool?'':last,Prenom:hasPool?'':first,DateNaissance:hasPool?'':birth,Photo:hasPool?'':sportText_(p.Photo),Email:sportText_(p.Email,160),Telephone:sportText_(p.Telephone,60),Adresse:sportText_(p.Adresse,500),Actif:p.Actif===true,ModifieLe:auditStamp_()};
 if(row.Email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.Email))throw new Error('Adresse e-mail incorrecte.');
 if(hasPool){const sh=table_('MONITEURS'),hs=sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0],raw=sh.getLastRow()>1?sh.getRange(2,1,sh.getLastRow()-1,1).getValues():[],index=raw.findIndex(r=>r[0]===id),target=index<0?sh.getLastRow()+1:index+2;
 const m={...(old||{}),MoniteurID:id,Nom:last,Prenom:first,NomAffiche:sportText_(p.NomAffiche,80)||first,Fonction:old?.Fonction||(role==='RESPONSABLE'?'Responsable':'Moniteur'),Photo:sportText_(p.Photo),DateNaissance:birth,Ordre:old?.Ordre||100,Actif:p.Actif===true};
 if(index<0)extendTable_(sh,target);const values=hs.map(h=>cell_('MONITEURS',h,m[h]));if(!old||JSON.stringify(values)!==JSON.stringify(hs.map(h=>cell_('MONITEURS',h,old[h]))))sh.getRange(target,1,1,hs.length).setValues([values]);}
 sportWrite_('EQUIPE_EXTRA',row,'ENREGISTRER_EQUIPE',extra);SpreadsheetApp.flush();return loadTeam_();
 }finally{lock.releaseLock();}
}
function loadSport_(name){authorize_();if(!SPORT_TABLES[name]||name==='EQUIPE_EXTRA')throw new Error('Section incorrecte.');const rows=sportRows_(name);return {rows,revision:revision_(rows),headers:SPORT_TABLES[name],monitors:teamRows_(),activities:SPORT_ACTIVITIES,children:name==='INSCRIPTIONS'?sportRows_('ENFANTS'):[],sessions:name==='INSCRIPTIONS'?sportRows_('SEANCES'):[]};}
function saveSport_(name,p,revision){
 if(name==='SUIVI_MENSUEL' && context.actor.role!=='DIRECTOR') {
  const old=sportRows_('SUIVI_MENSUEL').find(row=>row.SuiviID===p.SuiviID);
  if(p.StatutFiche==='VALIDEE'||old&&old.StatutFiche==='VALIDEE')throw Error('La validation et la réouverture sont réservées à la direction.');
 }
 authorize_();if(!['SEANCES','ENFANTS','INSCRIPTIONS','SUIVI_MENSUEL'].includes(name))throw new Error('Section incorrecte.');const lock=LockService.getScriptLock();lock.waitLock(10000);
 try{const all=sportRows_(name);if(revision_(all)!==revision)throw new Error('La liste a changé. Fermez puis rechargez.');const hs=SPORT_TABLES[name],key=hs[0],id=sportId_(p[key])||Utilities.getUuid(),old=all.find(r=>r[key]===id);if(p[key]&&!old)throw new Error('Élément introuvable.');
 const row=Object.fromEntries(hs.map(h=>[h,h===key?id:['Active','Actif'].includes(h)?p[h]===true:sportText_(p[h],h==='Note'?800:250)]));
 if(name==='SEANCES'){
  if(!SPORT_ACTIVITIES[row.Secteur])throw new Error('Choisissez un secteur.');const m=teamRows_().find(m=>m.MoniteurID===row.MoniteurID);if(!m||(row.Active&&!payTrue_(m.Actif))||!m.Secteurs.includes(row.Secteur))throw new Error('Cette personne ne peut pas être affectée à ce secteur.');
  payDate_(row.Date);const a=payTime_(row.HeureDebut),z=payTime_(row.HeureFin);if(z<=a)throw new Error('La fin doit suivre le début.');if(!row.Titre||!row.Activite||!row.Lieu)throw new Error('Titre, activité et lieu requis.');row.Capacite=payNumber_(p.Capacite,1,200,'Capacité');if(!Number.isInteger(row.Capacite))throw new Error('Capacité entière requise.');
  if(row.Active&&all.some(s=>s.SeanceID!==id&&payTrue_(s.Active)&&s.MoniteurID===row.MoniteurID&&s.Date===row.Date&&s.HeureDebut<row.HeureFin&&s.HeureFin>row.HeureDebut))throw new Error('Ce moniteur a déjà une séance à cette heure.');
  const booked=sportRows_('INSCRIPTIONS').filter(r=>r.SeanceID===id&&payTrue_(r.Active)&&r.Statut!=='ANNULE').length;if(row.Capacite<booked)throw new Error('La capacité est inférieure au nombre d’inscrits.');
 }
 if(name==='ENFANTS'){if(!row.Nom||!row.Prenom)throw new Error('Nom et prénom requis.');if(row.DateNaissance){payDate_(row.DateNaissance);if(row.DateNaissance>Utilities.formatDate(new Date(),TZ,'yyyy-MM-dd'))throw new Error('Naissance future.');}if(!old&&all.some(r=>r.Nom.toLowerCase()===row.Nom.toLowerCase()&&r.Prenom.toLowerCase()===row.Prenom.toLowerCase()&&r.DateNaissance===row.DateNaissance))throw new Error('Cet enfant existe déjà.');}
 if(name==='INSCRIPTIONS'){
  const s=sportRows_('SEANCES').find(s=>s.SeanceID===row.SeanceID),kid=sportRows_('ENFANTS').find(c=>c.EnfantID===row.EnfantID);if(!s||!kid)throw new Error('Séance ou enfant introuvable.');if(!['PREVU','PRESENT','ABSENT','ANNULE'].includes(row.Statut))throw new Error('Statut incorrect.');
  if(row.Active&&row.Statut!=='ANNULE'){if(!payTrue_(s.Active)||!payTrue_(kid.Actif))throw new Error('Séance ou enfant archivé.');if(all.some(r=>r.InscriptionID!==id&&r.SeanceID===row.SeanceID&&r.EnfantID===row.EnfantID&&payTrue_(r.Active)&&r.Statut!=='ANNULE'))throw new Error('Cet enfant est déjà inscrit.');const n=all.filter(r=>r.InscriptionID!==id&&r.SeanceID===row.SeanceID&&payTrue_(r.Active)&&r.Statut!=='ANNULE').length;if(n>=Number(s.Capacite))throw new Error('Cette séance est complète.');}
 }
 if(name==='SUIVI_MENSUEL'){
  requireMonitor_(row.MoniteurID);payMonth_(row.Mois);if(!['ATTENDUE','RECUE','VALIDEE','NON_REQUISE'].includes(row.StatutFiche))throw new Error('Statut de fiche incorrect.');if(all.some(r=>r.SuiviID!==id&&r.MoniteurID===row.MoniteurID&&r.Mois===row.Mois))throw new Error('Un suivi existe déjà pour ce mois.');
  if(row.DateLimite)payDate_(row.DateLimite);if(row.DateReception){payDate_(row.DateReception);if(row.DateReception>Utilities.formatDate(new Date(),TZ,'yyyy-MM-dd'))throw new Error('Réception future.');}if(['RECUE','VALIDEE'].includes(row.StatutFiche)&&!row.DateReception)throw new Error('Date de réception requise.');
  if(row.DocumentID&&!privateRows_('DOCUMENTS').some(d=>d.DocumentID===row.DocumentID&&d.MoniteurID===row.MoniteurID))throw new Error('Document de ce moniteur introuvable.');
 }
 sportWrite_(name,row,'ENREGISTRER_'+name,old);return loadSport_(name);
 }finally{lock.releaseLock();}
}
function monthlyFollowup_(month){
 authorize_();payMonth_(month);const rows=sportRows_('SUIVI_MENSUEL'),docs=loadContracts_(),today=Utilities.formatDate(new Date(),TZ,'yyyy-MM-dd');const next=new Date(month+'-01T00:00Z');next.setUTCMonth(next.getUTCMonth()+1);next.setUTCDate(-1);const deadline=next.toISOString().slice(0,10);
 return {month,revision:revision_(rows),rows:teamRows_().filter(m=>payTrue_(m.Actif)).map(m=>{const follow=rows.find(r=>r.MoniteurID===m.MoniteurID&&r.Mois===month)||{MoniteurID:m.MoniteurID,Mois:month,StatutFiche:'ATTENDUE',DateLimite:deadline};
 const contracts=docs.rows.filter(d=>d.MoniteurID===m.MoniteurID&&payTrue_(d.Active)&&(!d.DateFin||d.DateFin>=month+'-01')&&(!docs.signatureStates[d.DocumentID]?.startDate||docs.signatureStates[d.DocumentID].startDate<=month+'-31'));
 const pending=contracts.filter(d=>docs.signatureStates[d.DocumentID]?.status!=='SIGNE');
 return {...follow,name:[m.Prenom,m.Nom].join(' '),contractState:!contracts.length?'MANQUANT':pending.length?'A_SIGNER':'SIGNE',late:follow.StatutFiche==='ATTENDUE'&&(follow.DateLimite||deadline)<today,contracts:contracts.length,pending:pending.length};})};
}
function markContractSent_(id,date,revision){
 authorize_();payDate_(date);if(date>Utilities.formatDate(new Date(),TZ,'yyyy-MM-dd'))throw new Error('Date d’envoi future.');const lock=LockService.getScriptLock();lock.waitLock(10000);try{const list=loadContracts_();if(list.revision!==revision)throw new Error('Les documents ont changé. Actualisez.');if(!list.rows.some(r=>r.DocumentID===id))throw new Error('Contrat introuvable');const props=PropertiesService.getScriptProperties(),state=list.signatureStates[id]||{};props.setProperty('CONTRACT_STATUS_'+id,JSON.stringify({...state,sentDate:date,sentBy:authorize_()}));return loadContracts_();}finally{lock.releaseLock();}
}

/* Actifs privés de l’administration, sans accès Raspberry. */
function sportLogo_(){return 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxODAiIGhlaWdodD0iMTIwIiB2aWV3Qm94PSIwIDAgMTgwIDEyMCI+PHJlY3Qgd2lkdGg9IjE4MCIgaGVpZ2h0PSIxMjAiIHJ4PSIyNCIgZmlsbD0iIzA4N2I4NiIvPjx0ZXh0IHg9IjkwIiB5PSI3OSIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZm9udC1mYW1pbHk9IkFyaWFsLHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iNTYiIGZvbnQtd2VpZ2h0PSJib2xkIiBmaWxsPSJ3aGl0ZSI+QVM8L3RleHQ+PC9zdmc+';}
function employerSignature_(){return '';}

 const actions={
    "bootstrap":bootstrap_,
    "loadTable":loadTable_,
    "saveRow":saveRow_,
    "reorderSlides":reorderSlides_,
    "uploadImage":uploadImage_,
    "getMediaPreview":getMediaPreview_,
    "loadManagementTable":loadManagementTable_,
    "payrollReport":payrollReport_,
    "saveManagementRow":saveManagementRow_,
    "closePayroll":closePayroll_,
    "reopenPayroll":reopenPayroll_,
    "archiveSchedule":archiveSchedule_,
    "restoreSchedule":restoreSchedule_,
    "uploadMonitorDocument":uploadMonitorDocument_,
    "archiveDocument":archiveDocument_,
    "openMonitorDocument":openMonitorDocument_,
    "loadTeam":loadTeam_,
    "saveTeam":saveTeam_,
    "loadSport":loadSport_,
    "saveSport":saveSport_,
    "monthlyFollowup":monthlyFollowup_,
    "markContractSent":markContractSent_,
    "loadContractForm":loadContractForm_,
    "previewStudentContract":previewStudentContract_,
    "generateStudentContract":generateStudentContract_,
    "loadContracts":loadContracts_,
    "uploadSignedContract":uploadSignedContract_,
    "loadMonitorDossier":loadMonitorDossier_,
    "setPayrollStandby":setPayrollStandby_,
    "saveContractDraft":saveContractDraft_
 };
 return {invoke:(method,args)=>{if(!context.actor||!Object.prototype.hasOwnProperty.call(actions,method))throw Error('Commande administrative non autorisée.');return actions[method](...args);}};
}


// ===== Main.gs =====
function doGet(){const html=HtmlService.createHtmlOutputFromFile('Index').getContent(),correction=HtmlService.createHtmlOutputFromFile('DirectorCorrectionUi').getContent();return HtmlService.createHtmlOutput(html.replace(/<\/body>/i,correction+'</body>')).setTitle('AtoutSport — Gestion administrative').addMetaTag('viewport','width=device-width, initial-scale=1, viewport-fit=cover');}
function portalRpc(token,action,payload){
 try{
  const routes={bootstrap:pBootstrap_,month:pMonth_,saveDraft:pSaveDraft_,submit:pSubmit_,dashboard:pDashboard_,review:pReview_,recoveries:pRecoveries_,saveRecovery:pSaveRecovery_,assignRecovery:pAssignRecovery_,documents:pDocuments_,uploadDocument:pUploadDocument_,downloadDocument:pDownloadDocument_,reviewDocument:pReviewDocument_,users:pUsers_,inviteUser:pInviteUser_,changeUser:pChangeUser_,diagnostic:pDiagnostic_,mailLog:pMailLog_,retryMail:pRetryMail_,legacyUi:pLegacyUi_,legacy:pLegacy_};
  routes.getIdentity=pGetIdentity_;routes.revealIdentity=pRevealIdentity_;routes.submitIdentity=pSubmitIdentity_;routes.reviewIdentity=pReviewIdentity_;
  routes.getProfile=pGetProfile_;routes.saveProfile=pSaveProfile_;routes.requestProfileEmail=pRequestProfileEmail_;
  if(!['activate','completeProfileEmail'].includes(action)&&!Object.prototype.hasOwnProperty.call(routes,action))throw Error('Action inconnue.');
  const identity=pVerifiedIdentity_(token),p=payload&&typeof payload==='object'&&!Array.isArray(payload)?payload:{};
  // Vérifier à nouveau l'état du compte sous verrou : une révocation interdit aussi les appels d'une session déjà ouverte.
  const data=pWithLock_(()=>{
   if(action==='activate')return pActivate_(identity,p);
   // Le nouvel email doit venir de Firebase : le corps client ne fait jamais autorité.
   if(action==='completeProfileEmail')return pCompleteProfileEmail_(identity,p);
   return routes[action](pActor_(identity),p);
  });
  return {ok:true,data};
 }catch(error){return {ok:false,error:error.message||'Opération impossible. Réessayez.'};}
}
function pBootstrap_(actor,p){return {actor,today:pToday_(),month:/^20\d\d-(0[1-9]|1[0-2])$/.test(p.month||'')?p.month:pToday_().slice(0,7),team:pTeam_(),people:pPeople_(),notificationsEnabled:pProperties_().getProperty('APP_EMAIL_ENABLED')==='true'};}
function pDiagnostic_(actor){
 if(!['DIRECTOR','TECHNICAL'].includes(actor.role))throw Error('Accès technique réservé.');
 const out=pRows_('OUTBOX');return {configured:getPortalConfig().configured,notificationsEnabled:pProperties_().getProperty('APP_EMAIL_ENABLED')==='true',pending:out.filter(x=>x.status==='PENDING').length,failed:out.filter(x=>x.status==='FAILED'||x.status==='UNKNOWN').length,sourceCheckedAt:pNow_(),poolMonitors:pTeam_().length,version:'3.4.0'};
}


// ===== DirectorCorrection.gs =====
/** Correction d'une fiche existante par la direction, sous le verrou portalRpc. */
function pCorrectSheetByDirector_(actor, payload) {
  pRequireDirector_(actor);
  if (actor.active !== true) throw Error('Compte de direction inactif.');
  const before = pReadSheet_(actor, payload.sheetId);
  pCheckRevision_(before, payload.revision);
  if (before.status === 'APPROVED') throw Error('Rouvrez la fiche validée avec un motif avant de la corriger.');
  if (!['DRAFT', 'RETURNED', 'SUBMITTED'].includes(before.status)) throw Error('État de fiche incompatible avec une correction.');
  if (before.month > pToday_().slice(0, 7)) throw Error('La correction d’un mois futur n’est pas disponible.');
  pTargetMonitor_(actor, {monitorId: before.monitorId}, false);
  const closures = pSourceRows_('ADMIN_BOOK_ID', 'CLOTURES', ['MoniteurID', 'Mois', 'Active']);
  if (closures.some(c => String(c.MoniteurID) === before.monitorId && c.Mois === before.month && pSourceTrue_(c.Active))) {
    throw Error('Le décompte administratif est clôturé. Rouvrez-le dans Paiements avant de corriger cette fiche.');
  }
  const reason = pTextValue_(payload.comment, 2000, 'Motif de correction');
  if (!reason) throw Error('Expliquez le motif de votre correction.');
  const context = pSheetContext_(before, before.month, before.monitorId);
  const corrected = pNormalizeSheetLines_(payload.lines, before.month, before.monitorId, context);
  const declarationNote = pTextValue_(payload.declarationNote === undefined ? before.declarationNote : payload.declarationNote, 2000, 'Explication des changements');
  const previous = pNormalizeSheetLines_(before.lines, before.month, before.monitorId, context);
  if (JSON.stringify(previous) === JSON.stringify(corrected) && declarationNote === (before.declarationNote || '')) {
    throw Error('Aucune modification de la fiche à enregistrer.');
  }
  // Le motif de la direction peut justifier les écarts sans modifier le texte initial du moniteur.
  const check = pCheckDeclarationReason_({declarationNote: declarationNote || reason}, corrected, context.expected, context.sourceMode);
  const at = pNow_();
  const record = {...before, lines: corrected, declarationNote, changedDates: check.differences,
    sourceMode: context.sourceMode, poolBaselineActivities: context.poolBaselineActivities,
    status: 'SUBMITTED', revision: before.revision + 1, updatedAt: at, updatedBy: actor.id,
    validatedAt: '', validatedBy: '', financeSnapshot: null, validationSummary: null,
    expectedSnapshot: before.expectedSnapshot || context.expected,
    directorCorrection: {actorId: actor.id, name: actor.name || 'Direction', at, reason,
      previousRevision: before.revision, previousStatus: before.status},
    directorCorrectionCount: (Number(before.directorCorrectionCount) || 0) + 1};
  // submittedAt / submittedBy / submissionCount restent ceux de l'envoi réel du moniteur.
  // pCommit_ conserve atomiquement la version précédente dans HISTORY et l'auteur dans AUDIT.
  pCommit_([{table: 'TIMESHEETS', record}], actor, 'CORRIGER_FICHE_DIRECTION');
  return pViewMonth_(actor, before.month, before.monitorId);
}
