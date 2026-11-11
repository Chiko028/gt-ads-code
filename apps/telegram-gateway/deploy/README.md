# Einrichtung auf dem VPS (nur Betreiber, mit sudo)

**Voraussetzung (nicht Teil dieses Pakets):** WP-006 gemergt; BotFather-Einstellungen (Gruppen sperren, Privacy-Modus) erledigt; DeepSeek-Schlüssel erzeugt (Prepaid-Guthaben, Auto-Aufladung aus). **Token und Schlüssel nie in einen Chat oder eine Datei im Repo einfügen** – nur in den versteckten Prompt unten.
Die Skripte ändern **nicht**: Firewall/UFW, SSH, Benutzer, Ports, Docker. Jedes Skript hat `--dry-run`.

## Schritte (S5)
1. **Trockenlauf ansehen:** `sudo bash deploy/install.sh --dry-run`
2. **Einrichten** (Verzeichnisse, root-eigener Code unter `/opt/gt-ads/telegram-gateway`, Konfiguration, Units; startet nichts): `sudo bash deploy/install.sh`
3. **Bot-Token ablegen** (versteckter Prompt, Wert wird nie angezeigt): `sudo bash deploy/set-credential.sh telegram_bot_token`
4. **ID ermitteln (E68):** `sudo systemctl start gt-ads-telegram-setup`, dann innerhalb von höchstens 10 Minuten dem Bot **eine Nachricht** senden; danach `journalctl -u gt-ads-telegram-setup --no-pager | grep setup_id` – die Zahl zur passenden Uhrzeit ist deine ID. Der Setup-Modus antwortet nicht und beendet sich selbst.
5. **ID eintragen:** `sudoedit /etc/gt-ads/telegram-gateway.toml` → `allowed_user_id = <Zahl>`; Limits prüfen (E73).
6. **DeepSeek-Schlüssel ablegen:** `sudo bash deploy/set-credential.sh deepseek_api_key`
7. **Aktivieren:** `sudo bash deploy/install.sh --enable` (prüft Credentials und Konfiguration, aktiviert den Autostart und startet den Dienst).

## Prüfbefehle (Betriebsnachweise OP-01…OP-06)
```
systemctl status gt-ads-telegram --no-pager            # OP-01 aktiv?
systemctl is-enabled gt-ads-telegram                   # OP-01 Autostart
ss -tlnp                                               # OP-02 vorher/nachher: kein neuer Listener
systemd-analyze security gt-ads-telegram --no-pager    # OP-03 Härtung
sudo -u taxiagent ls /srv/taxiwerbung /home/taxiadmin /etc/gt-ads/credentials   # OP-04 muss verweigert werden
journalctl -u gt-ads-telegram --no-pager | tail -50    # OP-05 nur Metadaten, kein Inhalt/Token
sudo systemctl restart gt-ads-telegram                 # OP-06 (echter Neustart des Servers nur mit Zustimmung)
```
Telegram-Tests (nur diese): `/start`, `/status`, eine einfache Nachricht (z. B. „Antworte mit dem Wort OK.").

## Rotation, Widerruf, Rückbau
- **Rotation:** `set-credential.sh` erneut ausführen, dann `sudo systemctl restart gt-ads-telegram`.
- **Widerruf:** Bot-Token bei BotFather (`/revoke`), DeepSeek-Schlüssel in der DeepSeek-Konsole; danach Credential-Dateien löschen.
- **Rückbau:** `sudo bash deploy/uninstall.sh --dry-run`, dann ohne `--dry-run`; optional `--purge-credentials`, `--purge-state`.

## Hinweise
- Der Dienst läuft als `taxiagent` ohne Login, ohne sudo, ohne Zugriff auf `/srv/taxiwerbung`, `/home`, `/root`. Der Code gehört `root` und ist für `taxiagent` nur lesbar.
- Falls die Namensauflösung unter `RestrictAddressFamilies=AF_INET AF_INET6` fehlschlägt (Journal: Auflösungsfehler), ist das ein Befund für OP-03; `AF_UNIX` nur nach Prüfung und dokumentierter Entscheidung ergänzen.
- Meldet `/status` „Modell nicht verfügbar (balance)", ist das Prepaid-Guthaben aufgebraucht oder der Schlüssel ungültig (402/401).
