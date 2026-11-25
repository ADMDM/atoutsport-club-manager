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
