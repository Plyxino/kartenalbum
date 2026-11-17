# Kartenalbum ins Internet bringen (kostenlos, einmalig etwa 10 Minuten)

Die App braucht eine sichere Adresse (https), sonst gibt Safari auf dem iPhone die Kamera nicht frei.
GitHub Pages hostet die Dateien gratis.

## Teil 1: Konto und Ablage (macht ein Erwachsener)

1. Auf https://github.com gehen, oben rechts „Sign up“. E-Mail, Passwort und einen Benutzernamen
   wählen, den Bestätigungscode aus der E-Mail eingeben. Kostenlos, kein Zahlungsmittel nötig.
2. Nach dem Anmelden oben rechts auf das Plus und „New repository“.
   - Repository name: `kartenalbum`
   - Public (öffentlich) lassen
   - Nichts ankreuzen (kein README), dann „Create repository“.
3. Claude im Code-Fenster sagen: „GitHub-Konto ist da, Benutzername ist …“.
   Claude lädt die Dateien aus diesem Ordner dann hoch. Dabei öffnet sich einmal ein kleines
   Anmeldefenster von GitHub auf dem PC, dort mit dem neuen Konto anmelden.
4. Im Repository auf „Settings“, links „Pages“. Bei „Build and deployment“:
   Source = „Deploy from a branch“, Branch = `main`, Ordner `/ (root)`, „Save“.
   Nach ein bis zwei Minuten steht oben die Adresse, zum Beispiel
   `https://BENUTZERNAME.github.io/kartenalbum/`.

## Teil 2: Auf dem iPhone einrichten (macht Sean)

1. Die Adresse in Safari öffnen.
2. Unten auf das Teilen-Symbol (Quadrat mit Pfeil), dann „Zum Home-Bildschirm“, „Hinzufügen“.
3. Die App vom Home-Bildschirm starten, Konto erstellen, „Kamera starten“ und beim ersten Mal
   die Kamera erlauben.

## Wenn Claude etwas ändert

Claude lädt die neuen Dateien wieder hoch, die Adresse bleibt gleich. Auf dem iPhone die App
einmal schließen und neu öffnen, dann ist die neue Fassung da.

## Wichtig zu wissen

- Die Sammlung liegt auf dem Gerät, auf dem gescannt wird. Wer am PC und am iPhone sammeln
  will, nimmt „Sammlung sichern (Datei)“ und lädt die Datei auf dem anderen Gerät.
- Die Kartendaten (Name, Set, Bild, Jahr) kommen von der kostenlosen Datenbank TCGdex
  (https://tcgdex.dev). Dafür braucht die App Internet.
