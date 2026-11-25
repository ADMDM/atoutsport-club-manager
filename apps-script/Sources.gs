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
