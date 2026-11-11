#!/usr/bin/env bash
# SSH-Härtung mit automatischem Rückfall. Aufruf: sudo bash 10-ssh-harden.sh
set -Eeuo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausführen"; exit 1; }
TS=$(date +%Y%m%d-%H%M%S)
BK=/root/ssh-backup-$TS
ROLLBACK_MIN=10
HARD=/etc/ssh/sshd_config.d/00-hardening.conf
TIMER=ssh-rollback

grep -qE '^ssh-ed25519 ' /home/taxiadmin/.ssh/authorized_keys || { echo "Kein Schlüssel für taxiadmin -> Abbruch"; exit 1; }
sshd -t || { echo "Aktuelle Konfiguration schon fehlerhaft -> Abbruch"; exit 1; }
[ ! -e "$HARD" ] || { echo "$HARD existiert bereits -> Abbruch (nichts geändert)"; exit 1; }

# Alte Timer-Reste entfernen
systemctl stop $TIMER.timer $TIMER.service 2>/dev/null || true
systemctl reset-failed $TIMER.timer $TIMER.service 2>/dev/null || true

# 1. Backup
mkdir -p "$BK"; chmod 700 "$BK"
cp -a /etc/ssh/sshd_config /etc/ssh/sshd_config.d "$BK"/
echo "$BK" > /root/.ssh-backup-latest
echo "Backup: $BK"

# 2. Rückfall-Skript (eigenständig, unabhängig von dieser Sitzung)
cat > /root/ssh-rollback.sh <<RB
#!/usr/bin/env bash
set -e
BK=\$(cat /root/.ssh-backup-latest)
rm -f $HARD
cp -a "\$BK"/sshd_config /etc/ssh/sshd_config
cp -a "\$BK"/sshd_config.d/. /etc/ssh/sshd_config.d/
sshd -t && systemctl reload ssh
echo "SSH-Konfiguration aus \$BK wiederhergestellt"
RB
chmod 700 /root/ssh-rollback.sh

# 3. Timer ZUERST scharf stellen (läuft über systemd weiter, auch wenn Sitzung/Skript abbricht)
systemd-run --unit=$TIMER --on-active=${ROLLBACK_MIN}m /root/ssh-rollback.sh >/dev/null
echo "Auto-Rückfall in ${ROLLBACK_MIN} Minuten geplant ($TIMER.timer)"

# Bei jedem Fehler danach: sofort zurück, Timer bleibt als Reserve bestehen
trap 'echo "FEHLER -> sofortiger Rückfall"; /root/ssh-rollback.sh || true; systemctl stop '$TIMER'.timer 2>/dev/null || true' ERR

# 4. Neue Konfiguration (00- => wird zuerst gelesen, erster Wert gewinnt)
cat > "$HARD" <<CFG
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
X11Forwarding no
CFG
chmod 644 "$HARD"

# 5. Validieren: Syntax UND effektive Werte
sshd -t
EFF=$(sshd -T)
for kv in "permitrootlogin no" "passwordauthentication no" "kbdinteractiveauthentication no" "pubkeyauthentication yes" "x11forwarding no"; do
  echo "$EFF" | grep -qix "$kv" || { echo "Effektiver Wert abweichend: $kv"; false; }
done
echo "$EFF" | grep -Ei '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|x11forwarding) '
systemctl reload ssh
trap - ERR
echo
echo "ANGEWENDET. Bestehende Sitzungen bleiben offen. JETZT in NEUEM lokalen Terminal testen:"
echo "  ssh taxiwerbung                                   # muss klappen"
echo "  ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password taxiadmin@taxiwerbung   # muss ABGELEHNT werden"
echo "  ssh root@taxiwerbung                              # muss ABGELEHNT werden"
echo "Wenn alles passt:  sudo bash 11-ssh-confirm.sh   (innerhalb ${ROLLBACK_MIN} Min)"
echo "Sofort zurück:     sudo bash /root/ssh-rollback.sh"
