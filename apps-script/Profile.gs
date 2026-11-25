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
