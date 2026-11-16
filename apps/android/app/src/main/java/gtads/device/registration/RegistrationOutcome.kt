package gtads.device.registration

/**
 * Anzeigekategorie des letzten Registrierungsversuchs. Die Werte entstehen
 * ausschliesslich aus dem neutralen Transport- und Speicherergebnis und
 * enthalten weder Rohtexte noch Serverinhalte.
 */
enum class RegistrationOutcome {
    REGISTERED,
    INVALID_INPUT,
    CODE_REJECTED,
    RATE_LIMITED,
    NETWORK_ERROR,
    UNCERTAIN,
}
