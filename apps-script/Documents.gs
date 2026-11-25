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
