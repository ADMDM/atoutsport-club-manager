# Installer une instance indépendante

Cette procédure crée une **nouvelle installation**. Elle ne sert pas à remplacer une instance existante. Utiliser son propre compte Google, son projet Firebase et ses données. Les comptes des moniteurs sont des comptes Firebase : ils n’ont pas besoin d’être des comptes Gmail.

## 1. Préparer les fichiers

Télécharger le ZIP du dépôt via **Code → Download ZIP**, puis extraire les fichiers. Le dossier `deploy/` est prêt à copier. Pour reconstruire depuis les sources, utiliser Python 3.10+ et Node.js 22+ :

```sh
python3 scripts/build.py
node --test tests/*.test.cjs
```

Ne pas copier `demo/` dans Apps Script : ce dossier simule les réponses du serveur.

## 2. Créer Firebase Authentication

Dans la [console Firebase](https://console.firebase.google.com/) :

1. Créer un projet dédié au club.
2. Dans **Authentication → Sign-in method**, activer **Email/Password**.
3. Configurer une politique de mot de passe d’au moins 12 caractères. Activer la protection contre l’énumération des adresses si disponible.
4. Ajouter une application Web et relever `apiKey`, `authDomain`, `projectId` et `appId`.
5. Personnaliser les emails de vérification et de réinitialisation. Conserver les liens d’action Firebase standards.

Le portail utilise la configuration Web Firebase, pas une clé de compte de service. Aucune clé privée Firebase n’est nécessaire dans le navigateur. Vérifier les quotas et conditions applicables à son projet lors de l’installation.

Référence : [authentification par mot de passe](https://firebase.google.com/docs/auth/web/password-auth).

## 3. Créer Apps Script

Créer un projet autonome dans [Apps Script](https://script.google.com/).

| Fichier du dépôt | Fichier dans l’éditeur |
| --- | --- |
| `deploy/Code.gs` | Script `Code` |
| `deploy/Index.html` | HTML `Index` |
| `deploy/Legacy.html` | HTML `Legacy` |
| `deploy/DirectorCorrectionUi.html` | HTML `DirectorCorrectionUi` |
| `deploy/appsscript.json` | Manifeste `appsscript.json` |

Afficher le manifeste via **Paramètres du projet**. Ne pas ajouter en plus les modules de `apps-script/` : ils sont déjà assemblés dans `Code.gs`.

Le manifeste active le service avancé **Sheets v4**. Avec un projet Google Cloud standard, activer aussi l’API Google Sheets dans ce projet. Les lectures simples peuvent réussir alors que les écritures groupées échouent si cette API manque.

Référence : [services avancés Apps Script](https://developers.google.com/apps-script/guides/services/advanced).

## 4. Renseigner ses propriétés

Dans **Paramètres du projet → Propriétés du script**, saisir :

| Propriété | Valeur |
| --- | --- |
| `INSTALLER_EMAIL` | Adresse Google du propriétaire qui exécute l’installation |
| `INITIAL_DIRECTOR_EMAIL` | Adresse personnelle du responsable qui utilisera le portail |
| `INITIAL_DIRECTOR_NAME` | Nom affiché de ce responsable |
| `FIREBASE_API_KEY` | `apiKey` Web de Firebase |
| `FIREBASE_AUTH_DOMAIN` | `authDomain` |
| `FIREBASE_PROJECT_ID` | `projectId` |
| `FIREBASE_APP_ID` | `appId` |
| `APP_EMAIL_ENABLED` | `false` |

L’exemple `examples/script-properties.example.json` est un aide-mémoire. Ne pas copier les adresses `example.test` : elles ne reçoivent aucun email et sont refusées pour la direction initiale.

Laisser absentes les propriétés de classeurs et de dossiers : l’installation crée `TV_BOOK_ID`, `ADMIN_BOOK_ID`, `PORTAL_BOOK_ID`, `MEDIA_FOLDER_ID`, `PHOTO_FOLDER_ID` et `PORTAL_FOLDER_ID`. Les trois classeurs sont distincts. L’installateur ne remplace pas les en-têtes d’un tableau existant incompatible.

## 5. Créer les données de départ

Les fonctions internes finissent par `_` et ne figurent pas dans le sélecteur d’exécution. Pour les appeler :

1. Ajouter temporairement un fichier Script `Maintenance` avec le contenu de `scripts/Maintenance.gs`.
2. Sélectionner **runInstallPortal**, puis **Exécuter** avec le compte indiqué dans `INSTALLER_EMAIL`.
3. Examiner les autorisations Google. Le script doit accéder aux tableaux, aux documents, au réseau et aux fonctions de courrier/déclencheurs prévues par le manifeste.
4. Consulter le résultat : trois classeurs créés, un compte de direction préparé, notifications désactivées. Aucun email n’est envoyé.
5. Supprimer le fichier `Maintenance` avant de créer une version Web.

Les classeurs administratifs et les documents privés restent privés. Ne pas les partager avec les moniteurs : l’application donne les accès nécessaires. Un éventuel lecteur TV ne doit recevoir que les ressources d’affichage dont il a besoin.

## 6. Publier la connexion

Dans **Déployer → Nouveau déploiement → Application Web** :

- Exécuter en tant que **propriétaire du projet**.
- Autoriser l’accès à la page à **tout le monde**, lorsque la politique du compte le permet.

Cela rend la page de connexion accessible. Les données passent par `portalRpc`, qui vérifie le jeton Firebase et les droits. Ne jamais ajouter de fonction publique de lecture de tableau.

Vérifier avant publication que seules `doGet`, `getPortalConfig` et `portalRpc` sont des points d’entrée publics dans le code livré, et que `Maintenance` est retiré.

Copier l’URL obtenue, terminant par **`/exec`**, dans `APP_URL`. Ne pas utiliser `/dev` pour les invitations. Ouvrir le lien en navigation privée : il doit afficher la connexion et aucune donnée personnelle.

Référence : [déploiement d’une application Web](https://developers.google.com/apps-script/guides/web).

## 7. Activer le premier compte

1. Réajouter temporairement `Maintenance` dans le code de travail de l’éditeur. **Ne pas publier une version contenant ce fichier.** Le déploiement `/exec` garde sa version précédente.
2. Exécuter **runPrepareInvitations**. Sur une installation neuve, seule la direction est créée. L’invitation est mise en attente, sans envoi.
3. Exécuter **runCheckInstall** : vérifier le nombre de comptes et de messages en attente.
4. Exécuter **runEnableMail**, puis **runDeliverMail**. Cela active les notifications de cette instance et envoie les messages en attente.
5. Ouvrir l’invitation reçue, créer son mot de passe, vérifier son adresse puis revenir au portail.
6. Tester la connexion et la déconnexion. Supprimer `Maintenance` de l’éditeur après usage.

**runDisableMail** arrête les notifications et leurs déclencheurs. Il ne retire pas les emails déjà envoyés. Les invitations expirent après sept jours ; renouveler une invitation depuis le portail après expiration.

## 8. Ajouter son équipe

Avec le compte de direction :

1. Ouvrir **Équipe et gestion**, créer une personne et son activité.
2. Compléter le planning piscine si nécessaire. Les activités hors piscine utilisent une saisie manuelle.
3. Dans **Utilisateurs**, inviter cette personne avec son adresse et sa fiche associée.
4. Tester le parcours sur un compte d’essai avant d’inviter toute l’équipe.
5. Contrôler les tarifs et les paramètres de l’organisation. Les coordonnées de l’employeur et sa signature ne sont pas préremplies dans l’édition publique.

## 9. Vérifier avant usage réel

Utiliser les scénarios de [VALIDATION.md](VALIDATION.md). Vérifier les accès d’un moniteur, les deux corrections, le suivi des documents, l’envoi d’un message et le retour après déconnexion. Les tests locaux simulent Google ; la réception des mails et les autorisations réelles se constatent dans son propre projet.

Le fuseau métier est **Europe/Brussels** dans plusieurs modules. Le changer demande d’adapter ensemble le manifeste, les calculs de dates et les déclencheurs, puis de refaire les tests de calendrier.

Pour mettre à jour une instance déjà installée, sauvegarder ses sources et ses données, remplacer les fichiers du code, puis mettre à jour le **déploiement existant** avec une nouvelle version. Conserver les propriétés, les comptes et l’URL. Ne pas relancer une installation neuve sur les données de production.
