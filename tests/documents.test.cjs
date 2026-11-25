const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../apps-script/Documents.gs'), 'utf8');
const actors = {
  owner: {id:'user-a', email:'a@example.test', name:'Alice', role:'MONITOR', monitorId:'MON-A', active:true},
  other: {id:'user-b', email:'b@example.test', name:'Benoît', role:'MONITOR', monitorId:'MON-B', active:true},
  tech: {id:'user-t', email:'t@example.test', name:'Technicien', role:'TECHNICAL', monitorId:'MON-T', active:true},
  director: {id:'user-d', email:'d@example.test', name:'Directeur', role:'DIRECTOR', monitorId:'', active:true},
  secretary: {id:'user-s', email:'s@example.test', name:'Secrétariat', role:'SECRETARY', monitorId:'', active:true}
};
const upload = (overrides={}) => ({title:'Contrat retourné', category:'CONTRAT', visibility:'PRIVATE',
  filename:'contrat.pdf', mime:'application/pdf', base64:Buffer.from('%PDF-1.4\n%%EOF').toString('base64'),
  requestId:'request-id-00000001', ...overrides});

function harness() {
  const tables={DOCUMENTS:[], OUTBOX:[]}, files=new Map(), actions=[];
  const state={private:true, editors:[], viewers:[], failCommit:false, loseCommitResponse:false, legacy:[], properties:{}};
  const newFile = blob => {
    const id='drive-'+(files.size+1);
    const file={id, blob, trashed:false, getId:()=>id, getSize:()=>blob.bytes.length, getBlob:()=>blob,
      getName:()=>blob.name, isTrashed(){return this.trashed;}, setTrashed(value){this.trashed=value; return this;}};
    files.set(id,file);return file;
  };
  const props={ADMIN_BOOK_ID:'private-book',PORTAL_FOLDER_ID:'private-folder',APP_URL:'https://example.test/portal'};
  const ctx={console, pProperties_:()=>({getProperty:key=>state.properties[key]||props[key]||null}),
    pRows_:table=>tables[table]||[], pGet_:(table,id)=>(tables[table]||[]).find(row=>row.id===id)||null,
    pGetFresh_:(table,id)=>(tables[table]||[]).find(row=>row.id===id)||null,
    pCommit_:(changes, actor, action)=>{
      if(state.failCommit)throw Error('network');
      for(const {table,record}of changes){tables[table]??=[];const at=tables[table].findIndex(row=>row.id===record.id);if(at<0)tables[table].push(record);else tables[table][at]=record;}
      actions.push({actor,action});if(state.loseCommitResponse)throw Error('lost response');
    },
    pQueueMail_:(id,to,subject,text)=>({table:'OUTBOX',record:{id,to,subject,text}}),
    pDirectorEmail_:()=>actors.director.email, pTeam_:()=>[{id:'MON-A',active:true},{id:'MON-B',active:true},{id:'MON-T',active:true}],
    pPeople_:()=>[{id:'MON-A',active:true},{id:'MON-B',active:true},{id:'MON-T',active:true},{id:'DANCE-1',active:true},{id:'INACTIVE',active:false}],
    pNow_:()=> '2026-11-11T13:00:00Z', pId_:()=>crypto.randomUUID(),
    pHash_:value=>crypto.createHash('sha256').update(String(value)).digest('hex'),
    DriveApp:{Access:{PRIVATE:'PRIVATE'},getFolderById:()=>({getSharingAccess:()=>state.private?'PRIVATE':'ANYONE',
      getEditors:()=>state.editors,getViewers:()=>state.viewers,createFile:newFile}),getFileById:id=>{if(!files.has(id))throw Error('missing');return files.get(id);}},
    Utilities:{base64Decode:s=>Array.from(Buffer.from(s,'base64')),base64Encode:bytes=>Buffer.from(bytes).toString('base64'),
      newBlob:(bytes,mime,name)=>({bytes:Array.from(bytes),mime,name,getContentType:()=>mime,getBytes:()=>Array.from(bytes)})},
    SpreadsheetApp:{openById:()=>({getSheetByName:()=>({getLastRow:()=>state.legacy.length+1,getLastColumn:()=>9,
      getRange:()=>({getValues:()=>[['DocumentID','MoniteurID','Titre','Type','FichierID','DateDocument','DateFin','Active','CreeLe'],...state.legacy]})})})}
  };
  vm.createContext(ctx);vm.runInContext(source,ctx);return {ctx,tables,files,state,actions,newFile};
}

test('personal upload creates private metadata and an outbox event, never a Drive URL',()=>{
  const h=harness(), result=h.ctx.pUploadDocument_(actors.owner,upload());
  assert.equal(result.status,'TO_REVIEW');assert.equal(result.monitorId,'MON-A');assert.equal(result.revision,1);
  assert.equal(h.tables.DOCUMENTS.length,1);assert.equal(h.tables.OUTBOX.length,1);assert.equal(h.tables.OUTBOX[0].to,actors.director.email);
  assert.equal(result.fileId,undefined);assert.equal(result.fingerprint,undefined);assert.equal(result.requestId,undefined);
  assert.equal(JSON.stringify(result).includes('drive-'),false);
});

test('upload retry is idempotent, changed payload with same request ID is rejected',()=>{
  const h=harness(), first=h.ctx.pUploadDocument_(actors.owner,upload()), second=h.ctx.pUploadDocument_(actors.owner,upload());
  assert.equal(first.id,second.id);assert.equal(h.files.size,1);assert.equal(h.tables.OUTBOX.length,1);
  assert.throws(()=>h.ctx.pUploadDocument_(actors.owner,upload({title:'Autre contenu'})),/existe déjà/);
});

test('monitor and technical account cannot impersonate another monitor or upload shared documents',()=>{
  const h=harness();
  assert.throws(()=>h.ctx.pUploadDocument_(actors.owner,upload({monitorId:'MON-B'})),/propres/);
  assert.throws(()=>h.ctx.pUploadDocument_(actors.tech,upload({monitorId:'MON-A'})),/propres/);
  assert.throws(()=>h.ctx.pUploadDocument_(actors.owner,upload({visibility:'POOL'})),/non autorisée/);
  assert.throws(()=>h.ctx.pUploadDocument_({...actors.owner,active:false},upload()),/non autorisé/);
  assert.equal(h.files.size,0);
});

test('direct object access and document list filter other monitors, STAFF and archived shared docs',()=>{
  const h=harness(), personal=h.ctx.pUploadDocument_(actors.owner,upload());
  const pool=h.ctx.pUploadDocument_(actors.director,upload({visibility:'POOL',category:'GENERAL',requestId:'request-id-00000002'}));
  h.ctx.pUploadDocument_(actors.secretary,upload({visibility:'STAFF',category:'GENERAL',requestId:'request-id-00000003'}));
  assert.throws(()=>h.ctx.pDownloadDocument_(actors.other,{id:personal.id}),/non autorisé/);
  assert.throws(()=>h.ctx.pDownloadDocument_(actors.tech,{id:personal.id}),/non autorisé/);
  assert.equal(h.ctx.pDocuments_(actors.owner).rows.length,2);assert.equal(h.ctx.pDocuments_(actors.other).rows.length,1);
  assert.equal(h.ctx.pDocuments_(actors.secretary).rows.length,3);
  h.ctx.pReviewDocument_(actors.secretary,{id:pool.id,revision:1,status:'ARCHIVED'});
  assert.equal(h.ctx.pDocuments_(actors.other).rows.length,0);
  assert.throws(()=>h.ctx.pDownloadDocument_(actors.other,{id:pool.id}),/non autorisé/);
});

test('only director verifies personal documents; revisions prevent stale writes',()=>{
  const h=harness(), personal=h.ctx.pUploadDocument_(actors.owner,upload());
  assert.throws(()=>h.ctx.pReviewDocument_(actors.secretary,{id:personal.id,revision:1,status:'VERIFIED'}),/réservée/);
  assert.throws(()=>h.ctx.pReviewDocument_(actors.owner,{id:personal.id,revision:1,status:'VERIFIED'}),/réservée/);
  assert.throws(()=>h.ctx.pReviewDocument_(actors.secretary,{id:personal.id,revision:1,status:'ARCHIVED'}),/réservée/);
  const verified=h.ctx.pReviewDocument_(actors.director,{id:personal.id,revision:1,status:'VERIFIED'});
  assert.equal(verified.status,'VERIFIED');assert.equal(verified.revision,2);
  assert.throws(()=>h.ctx.pReviewDocument_(actors.director,{id:personal.id,revision:1,status:'ARCHIVED'}),/changé/);
  assert.equal(h.ctx.pDownloadDocument_(actors.owner,{id:personal.id}).mime,'application/pdf');
});

test('unsupported MIME, MIME spoofing, invalid Base64 and oversize are rejected before Drive writes',()=>{
  const h=harness();
  assert.throws(()=>h.ctx.pUploadDocument_(actors.owner,upload({mime:'image/svg+xml'})),/Format accepté/);
  assert.throws(()=>h.ctx.pUploadDocument_(actors.owner,upload({base64:Buffer.from('<html>x</html>').toString('base64')})),/format PDF/);
  assert.throws(()=>h.ctx.pUploadDocument_(actors.owner,upload({base64:'%%%'})),/incorrect/);
  assert.throws(()=>h.ctx.pUploadDocument_(actors.owner,upload({base64:'A'.repeat(8*1024*1024+4)})),/volumineux/);
  assert.equal(h.files.size,0);
});

test('storage folder must remain private',()=>{
  const h=harness();h.state.private=false;
  assert.throws(()=>h.ctx.pUploadDocument_(actors.owner,upload()),/privé/);
  h.state.private=true;h.state.editors=['outside@example.test'];
  assert.throws(()=>h.ctx.pUploadDocument_(actors.owner,upload()),/privé/);
  assert.equal(h.files.size,0);
});

test('maximum permitted upload does not overflow the base64 validator stack',()=>{
  const h=harness(), bytes=Buffer.alloc(6*1024*1024);bytes.write('%PDF-1.4\n');
  const doc=h.ctx.pUploadDocument_(actors.owner,upload({base64:bytes.toString('base64')}));
  assert.equal(doc.size,6*1024*1024);
});

test('failed transaction trashes only the new orphan file; lost success response preserves it',()=>{
  const h=harness();h.state.failCommit=true;
  assert.throws(()=>h.ctx.pUploadDocument_(actors.owner,upload()),/confirmé/);
  assert.equal(h.files.get('drive-1').trashed,true);assert.equal(h.tables.DOCUMENTS.length,0);
  h.state.failCommit=false;h.state.loseCommitResponse=true;
  const result=h.ctx.pUploadDocument_(actors.owner,upload());
  assert.equal(result.status,'TO_REVIEW');assert.equal(h.files.get('drive-2').trashed,false);
});

test('legacy contracts remain read-only and downloads check ownership before reading Drive',()=>{
  const h=harness();
  const file=h.newFile(h.ctx.Utilities.newBlob(Array.from(Buffer.from('%PDF-1.4\n%%EOF')),'application/pdf','contrat-original.pdf'));
  h.state.legacy=[['old-doc','MON-A','Ancien contrat','CONTRAT',file.id,'2026-09-01','',true,'2026-09-01']];
  const legacy=h.ctx.pDocuments_(actors.owner).rows[0];
  assert.equal(legacy.id,'legacy:old-doc');assert.equal(legacy.readOnly,true);assert.equal(legacy.fileId,undefined);
  assert.throws(()=>h.ctx.pDownloadDocument_(actors.other,{id:legacy.id}),/non autorisé/);
  assert.equal(h.ctx.pDownloadDocument_(actors.owner,{id:legacy.id}).filename,'contrat-original.pdf');
  assert.throws(()=>h.ctx.pReviewDocument_(actors.director,{id:legacy.id,revision:0,status:'VERIFIED'}),/lecture seule/);
  const returned=h.ctx.pUploadDocument_(actors.owner,upload({contractRef:legacy.id}));
  assert.equal(returned.contractRef,legacy.id);assert.equal(returned.status,'TO_REVIEW');
  assert.throws(()=>h.ctx.pUploadDocument_(actors.other,upload({contractRef:legacy.id})),/ne correspond pas/);
});

test('non-pool people can use private documents without accessing pool documents',()=>{
  const h=harness(), dancer={...actors.owner,id:'user-dance',monitorId:'DANCE-1'};
  const doc=h.ctx.pUploadDocument_(dancer,upload());
  const pool=h.ctx.pUploadDocument_(actors.director,upload({visibility:'POOL',category:'GENERAL',requestId:'request-id-00000002'}));
  assert.equal(doc.monitorId,'DANCE-1');
  assert.equal(h.ctx.pDocuments_(dancer).rows.length,1);
  assert.throws(()=>h.ctx.pDownloadDocument_(dancer,{id:pool.id}),/non autorisé/);
  assert.throws(()=>h.ctx.pUploadDocument_({...dancer,monitorId:'INACTIVE'},upload()),/active introuvable/);
  assert.throws(()=>h.ctx.pDownloadDocument_(actors.other,{id:doc.id}),/non autorisé/);
});

test('admin projection shows the same portal file and legacy records without exposing Drive IDs',()=>{
  const h=harness(), doc=h.ctx.pUploadDocument_(actors.owner,upload());
  h.state.legacy=[['old-doc','MON-A','Attestation','ATTESTATION','private-drive-file','','',true,'2026-09-01']];
  const rows=h.ctx.pDocumentsAdminList_(actors.director,{revision:'legacy-revision'});
  assert.equal(rows.revision,'legacy-revision');assert.equal(rows.rows.length,2);
  const projected=rows.rows.find(row=>row.DocumentID==='portal:'+doc.id);
  assert.equal(projected.PortalRevision,1);assert.equal(projected.MoniteurID,doc.monitorId);
  assert.equal(projected.StatutDocument,'TO_REVIEW');
  assert.equal(JSON.stringify(rows).includes('private-drive-file'),false);
  assert.equal(JSON.stringify(rows).includes('FichierID'),false);
  assert.equal(h.files.size,1);
  assert.throws(()=>h.ctx.pDocumentsAdminList_(actors.owner,{revision:'r'}),/réservée/);
  assert.equal(h.ctx.pDocumentsAdminList_(actors.secretary,{revision:'r'}).rows.find(row=>row.PortalRevision===1).CanArchive,false);
});

test('contract signature status is preserved and a signed return updates its original reference',()=>{
  const h=harness();
  h.state.legacy=[['original','MON-A','Contrat','CONTRAT','drive-original','','',true,'2026-09-01'],
    ['returned','MON-A','Contrat signé','CONTRAT','drive-returned','','',true,'2026-09-02'],
    ['draft','MON-A','Brouillon contrat','CONTRAT','drive-draft','','',true,'2026-09-03']];
  h.state.properties.CONTRACT_STATUS_original=JSON.stringify({status:'NON_SIGNE',sentDate:'2026-09-01'});
  h.state.properties.CONTRACT_STATUS_returned=JSON.stringify({status:'SIGNE',originalId:'original',signedDate:'2026-09-02'});
  let rows=h.ctx.pDocuments_(actors.owner).rows;
  const original=rows.find(row=>row.id==='legacy:original');
  assert.equal(original.status,'SIGNED');assert.equal(original.contractStatus,'SIGNE');assert.equal(original.sentDate,'2026-09-01');
  assert.equal(original.signedDate,'2026-09-02');
  assert.equal(rows.find(row=>row.id==='legacy:draft').status,'DRAFT');
  h.state.legacy[1][7]=false;
  rows=h.ctx.pDocuments_(actors.owner).rows;
  assert.equal(rows.find(row=>row.id==='legacy:original').status,'AWAITING_SIGNATURE');
  assert.equal(rows.find(row=>row.id==='legacy:returned').status,'ARCHIVED');
});

test('archive/restore in administration preserves verification, file identity, authorization and revisions',()=>{
  const h=harness(), doc=h.ctx.pUploadDocument_(actors.owner,upload());
  h.ctx.pReviewDocument_(actors.director,{id:doc.id,revision:1,status:'VERIFIED'});
  const originalFile=h.tables.DOCUMENTS[0].fileId;
  assert.throws(()=>h.ctx.pDocArchivePortal_(actors.secretary,{id:doc.id,revision:2,active:false}),/réservée/);
  assert.throws(()=>h.ctx.pDocArchivePortal_(actors.director,{id:doc.id,revision:1,active:false}),/changé/);
  const archived=h.ctx.pDocArchivePortal_(actors.director,{id:doc.id,revision:2,active:false});
  assert.equal(archived.status,'ARCHIVED');
  const restored=h.ctx.pDocArchivePortal_(actors.director,{id:doc.id,revision:3,active:true});
  assert.equal(restored.status,'VERIFIED');assert.equal(restored.revision,4);
  assert.equal(h.tables.DOCUMENTS[0].fileId,originalFile);assert.equal(h.files.size,1);
});

test('safe filenames cannot introduce paths, controls or a conflicting extension',()=>{
  const h=harness();
  const doc=h.ctx.pUploadDocument_(actors.owner,upload({filename:'../../unsafe\u202e.exe'}));
  assert.ok(doc.filename.endsWith('.pdf'));assert.equal(/[\/\\\u202e]/.test(doc.filename),false);
});

function zip(entries){
  const locals=[], central=[];let offset=0;
  for(const [name,text]of entries){const nameBytes=Buffer.from(name),data=Buffer.from(text),local=Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(nameBytes.length,26);
    locals.push(local,nameBytes,data);const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(nameBytes.length,28);c.writeUInt32LE(offset,42);
    central.push(c,nameBytes);offset+=local.length+nameBytes.length+data.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,end]);
}

test('DOCX validation checks required ZIP members and refuses macros and arbitrary ZIP',()=>{
  const h=harness(), mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const basic=[['[Content_Types].xml','<Types/>'],['word/document.xml','<document/>']];
  const valid=h.ctx.pUploadDocument_(actors.owner,upload({mime,filename:'contrat.docx',base64:zip(basic).toString('base64')}));
  assert.equal(valid.mime,mime);
  assert.throws(()=>h.ctx.pUploadDocument_(actors.owner,upload({mime,requestId:'request-id-00000002',base64:zip([['file.txt','x']]).toString('base64')})),/pas un document DOCX/);
  assert.throws(()=>h.ctx.pUploadDocument_(actors.owner,upload({mime,requestId:'request-id-00000003',base64:zip([...basic,['word/vbaProject.bin','x']]).toString('base64')})),/non accepté/);
});
