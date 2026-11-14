/**
 * CX-041: Die vorhandenen Vitest-Faelle liegen colocated beim Modul.
 * Dieser Sammelpunkt fuehrt sie im regulaeren npm-test-Lauf aus, ohne den
 * Test zu duplizieren oder abzuschwaechen.
 */
import "../../src/modules/manifestRefresh/manifestRefresh.test.js";
