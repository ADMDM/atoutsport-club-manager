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
