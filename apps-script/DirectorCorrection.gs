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
