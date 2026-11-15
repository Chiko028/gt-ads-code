// Der verbindliche Test liegt colocated im Auth-Modul (bestehender Aufbau wie
// CX-106/CX-065); diese Datei bindet ihn in die bestehende
// Vitest-Include-Konfiguration (tests/**) ein.
import "../../src/modules/adminAuth/recoveryRoutes.test.js";
