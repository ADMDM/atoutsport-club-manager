# Validation et périmètre

## Base de départ

Cette édition publique part du code applicatif 3.4, complété par l’aide administrative et la correction directe de direction utilisées en novembre 2026. Les paramètres, personnes, migrations de personnel, médias et signatures propres à l’installation d’origine ont été retirés. L’installation publique crée ses propres tableaux et son propre compte de direction.

Le code d’installation générique n’a pas été exécuté dans un nouveau compte Google au moment de cette publication. Ses contrôles et la création des structures sont testés localement avec les services simulés. Une personne qui réutilise le dépôt doit terminer la recette Google décrite ci-dessous.

## Contrôles reproductibles

```sh
python3 scripts/build.py
node --test tests/*.test.cjs
python3 scripts/check_public.py
```

**238 tests locaux passent.** La démonstration a aussi été ouverte dans Chrome : navigation vers une fiche, formulaire « Corriger moi-même », sauvegarde d’une correction fictive et affichage de son auteur/motif. Aucune donnée réelle n’a été utilisée pour cette vérification.

Les tests portent sur les plages et calendriers, les permissions, l’authentification, les révisions, le stockage groupé, les documents, les coordonnées, l’identité, les notifications, l’aide et les corrections. Les tests de fonctions spécifiques à la candidate 3.5 ne sont pas inclus : ces fonctions ne font pas partie de la base distribuée.

Les services Google et le DOM sont simulés. Un test local réussi ne prouve pas la réception d’un email, le bon réglage des autorisations Google ou le fonctionnement sur tous les appareils.

## Recette Google à réaliser dans son instance

| Scénario | Résultat attendu |
| --- | --- |
| Ouvrir le portail sans session | Connexion seule, aucune donnée de personnel |
| Activer une invitation | Mot de passe et adresse vérifiée requis |
| Se connecter comme moniteur | Sa fiche et ses documents autorisés uniquement |
| Enregistrer puis envoyer une fiche | Brouillon puis fiche à vérifier, révision mise à jour |
| Demander une correction | Retour au moniteur avec motif |
| Corriger comme direction | Plages modifiées, auteur et motif enregistrés, validation séparée |
| Rejouer une ancienne révision | Refus sans écraser les nouvelles données |
| Corriger une fiche validée ou clôturée | Réouverture préalable demandée |
| Charger un document personnel | Accès réservé au titulaire ou au responsable autorisé |
| Envoyer une notification d’essai | État d’envoi observé et réception réellement vérifiée |
| Refaire le tour guidé | Explications de la page courante, fermeture possible |

## Limites explicites

- Les déclarations du portail et les décomptes de l’administration historique sont encore deux circuits. Comparer leurs résultats avant clôture et paiement.
- Les montants affichés ne sont pas des virements. Le site ne se connecte pas à une banque.
- Le lecteur Raspberry Pi / TV n’est pas inclus.
- La démo est une simulation partielle du portail, pas une instance Google opérationnelle.
- Les modèles de contrats sont des modèles techniques hérités du contexte belge. Ils doivent être relus et adaptés avant signature. Aucune conformité juridique générale n’est annoncée.
- Le modèle bénévole reste un brouillon à compléter.
- Les relevés PDF mensuels automatiques et les fonctions de la candidate 3.5 sont exclus.
- Les quotas Google, les limites de taille des données et le fuseau Europe/Brussels sont à prendre en compte.
- Aucune revue indépendante de sécurité ni mesure de charge à grande échelle n’a été réalisée.

## Mise à jour et retour arrière

Sauvegarder les sources et les données avant une mise à jour. Publier une nouvelle version sur le déploiement existant pour conserver son URL. En cas de régression, réaffecter la version précédente. Revenir au code précédent ne supprime pas les corrections déjà enregistrées dans les données.
