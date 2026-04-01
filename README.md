# Trackdidia

Application desktop locale pour suivre les routines quotidiennes, les metriques de vie et le respect des principes personnels.

## Stack

- React + TypeScript + Vite
- Tauri pour le shell desktop
- SQLite via le plugin Tauri SQL
- Vitest + Testing Library

## Demarrage

1. Installer les dependances JavaScript
2. Installer la toolchain Rust pour lancer Tauri
3. Lancer le frontend ou l'application desktop

```bash
npm install
npm run dev
```

Pour lancer l'application Tauri une fois Rust installe :

```bash
npm run tauri dev
```

## Scripts

- `npm run dev` : frontend Vite
- `npm run build` : verification TypeScript + build Vite
- `npm run test` : tests unitaires et UI
- `npm run tauri dev` : shell desktop Tauri

## Notes

- Le mode navigateur utilise un repository memoire de previsualisation lorsque le runtime Tauri n'est pas disponible.
- Le mode desktop reste concu pour persister en SQLite local.

## Donnees locales

- En mode desktop, la base SQLite est ouverte via `sqlite:trackdidia.db`.
- Sur macOS, avec l'identifiant Tauri actuel `com.trackdidia.desktop`, le fichier se trouve dans `~/Library/Application Support/com.trackdidia.desktop/trackdidia.db`.
- Les fichiers `trackdidia.db-wal` et `trackdidia.db-shm` a cote sont normaux pour SQLite en mode WAL.
- Les backups manuels et automatiques sont ecrits dans `~/Library/Application Support/com.trackdidia.desktop/backups/`.
- Une mise a jour de l'application ne doit pas supprimer ces fichiers tant que l'identifiant Tauri reste le meme et que l'installateur ne nettoie pas le dossier de donnees utilisateur.
- L'application peut creer un backup manuel a la demande et verifier automatiquement toutes les heures si un nouveau backup est du apres 24h depuis le precedent.

## Politique de migration

- Toute evolution du schema SQLite doit passer par une migration ajoutee a la liste `migrations` dans [src/lib/storage/tauri-sqlite-repository.ts](/Users/didia/workspace/trackdidia/src/lib/storage/tauri-sqlite-repository.ts).
- A partir de maintenant, pas de modification manuelle hors migration pour la structure de base de donnees.
- Les migrations doivent etre incrementales et preserve-first: ajout de colonnes, backfill, transformation idempotente, puis lecture du nouveau champ dans le code.
- La table `schema_migrations` est la source de verite pour savoir quelles migrations ont deja ete appliquees sur une installation existante.
