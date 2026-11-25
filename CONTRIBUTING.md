# Contribuer

Ouvrir une issue avec le problème rencontré, le résultat attendu et un exemple fictif. Ne pas joindre de données de personnel ou d’accès de production.

Pour modifier le code :

1. Créer une branche à partir de `main`.
2. Modifier les sources dans `apps-script/`.
3. Ajouter ou adapter un test utile à la règle modifiée.
4. Exécuter `python3 scripts/build.py`, `node --test tests/*.test.cjs` et `python3 scripts/check_public.py`.
5. Mettre à jour la documentation et les fichiers générés de `deploy/`.
6. Ouvrir une pull request décrivant le problème, le comportement obtenu et les vérifications réalisées.

Garder les changements métier séparés des migrations de données. Une contribution utilisant un outil d’IA est bienvenue ; vérifier le résultat et préciser les limites des tests.
