# Gemini Extra (Extension Firefox)

Base d'extension Mozilla Firefox (Manifest V3) pour [Google Gemini](https://gemini.google.com).

## Structure du projet

- `manifest.json` : Configuration Manifest V3 compatible Firefox.
- `background/background.js` : Script d'arrière-plan (initialisation des paramètres par défaut).
- `content/content.js` & `content/content.css` : Scripts et styles injectés sur `https://gemini.google.com/*`.
- `popup/popup.html`, `popup/popup.css`, `popup/popup.js` : Interface du bouton d'extension avec interrupteur Activer/Désactiver.
- `icons/icon.svg` : Icône de l'extension.

## Tester dans Firefox

1. Ouvrir Firefox et aller à `about:debugging#/runtime/this-firefox`.
2. Cliquer sur **Charger un module complémentaire temporaire...**
3. Sélectionner le fichier `manifest.json` de ce dossier.
4. Ouvrir [gemini.google.com](https://gemini.google.com) et vérifier la console (`[Gemini Extra] Actif sur cette page.`) ainsi que le popup de l'extension.
