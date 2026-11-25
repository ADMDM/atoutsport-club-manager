# Sécurité et données personnelles

Ne jamais ajouter au dépôt de fiches de personnel, adresses réelles de moniteurs, numéros nationaux, coordonnées bancaires, signatures, contrats signés, exports Google, journaux de production, liens d’invitation ou clés privées.

Les exemples utilisent des identités fictives. Les coordonnées de l’installateur, les identifiants des ressources et la configuration de chaque instance restent dans les propriétés de son projet Apps Script.

Le contrôle `python3 scripts/check_public.py` détecte plusieurs formats sensibles et empêche la présence de fichiers d’export ou de configuration locale. Il ne remplace pas la revue humaine d’un changement avant publication.

Ne pas publier une vulnérabilité avec des données ou accès réels dans une issue. Utiliser le signalement privé de GitHub s’il est activé, ou contacter le mainteneur sans joindre de secret. Une issue publique peut décrire un défaut reproductible avec des données entièrement fictives.

Le dossier `scripts/Maintenance.gs` sert uniquement à l’éditeur et doit être retiré avant tout déploiement Web. Le build ne l’intègre pas.
