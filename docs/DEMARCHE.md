# Démarche et compétences mobilisées

## Origine du projet

Adam David Malila a porté ce projet à partir de son expérience de moniteur de natation : rendre les prestations et les démarches administratives plus simples pour l’équipe et les responsables. Le travail a avancé par besoins concrets, essais, corrections et documentation.

## Contribution humaine et assistance de l’IA

**Adam est le porteur et concepteur du projet.** Il a exprimé les besoins, défini les priorités et les parcours attendus, fourni le contexte métier et demandé les ajustements après usage. Le développement a été réalisé avec l’assistance de **ChatGPT/Codex**, notamment pour l’implémentation, le diagnostic, les tests et la documentation.

Cette mention décrit le mode de travail. Le dépôt ne prétend pas que chaque ligne a été écrite manuellement par Adam, ni qu’une revue indépendante de sécurité a été réalisée.

## Du besoin à une fonction vérifiable

| Besoin de terrain | Traduction technique | Critère de vérification |
| --- | --- | --- |
| Chaque moniteur doit voir sa fiche | Compte lié à une personne et droits serveur | Refus de lire ou modifier la fiche d’un autre |
| Ne pas perdre une correction | Révision, verrou et historique groupé | Refus d’une révision obsolète et conservation de la version précédente |
| La direction veut corriger elle-même | Action distincte, motif obligatoire et auteur enregistré | La fiche change sans être automatiquement validée |
| Une page doit être compréhensible | Aide contextuelle et tour guidé | Explication adaptée à la page et au formulaire ouverts |
| Éviter les relances en double | File d’envoi et état incertain explicite | Une interruption ne déclenche pas une seconde copie silencieuse |
| Réutiliser le projet ailleurs | Installateur indépendant et exemples fictifs | Aucun identifiant de production requis |

## Compétences illustrées

- Analyse fonctionnelle et traduction de règles métier en parcours utilisateur.
- Conception d’une application Web reliée à plusieurs services Google.
- Modélisation de données et adaptation d’un existant sans recommencer tout le système.
- Gestion des rôles et de la confidentialité côté serveur.
- Raisonnement sur les dates, horaires, révisions et opérations concurrentes.
- Tests de non-régression et distinction entre simulation et vérification réelle.
- Documentation destinée à un responsable non technique.
- Utilisation de l’IA comme outil de développement avec vérification des résultats.

## Exemple : correction d’une fiche

Le besoin initial était de permettre à la direction de faire corriger une fiche. Le retour utilisateur a précisé deux parcours : demander une correction au moniteur ou corriger directement. La solution conserve les deux, demande un motif et sépare correction et validation. Les tests couvrent notamment les autres rôles, les fiches clôturées, les conflits de révision et la conservation du formulaire après erreur.

## Pistes d’évolution

Découper davantage le module administratif historique, rapprocher plus complètement les deux circuits de décompte, compléter une recette automatisée dans un projet Google de test et documenter séparément un lecteur d’affichage. Les futurs relevés PDF mensuels automatiques ne sont pas présentés comme disponibles dans cette édition.
