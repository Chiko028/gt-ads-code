/**
 * CX-042: Die vier Vitest-Faelle liegen colocated beim Modul
 * (src/modules/deviceManifest/deviceManifest.test.ts). Die vorhandene
 * Vitest-Konfiguration sammelt nur tests/**; dieser Sammelpunkt fuehrt sie
 * im regulaeren npm-test-Lauf aus, ohne den Test zu duplizieren.
 */
import "../../src/modules/deviceManifest/deviceManifest.test.js";

