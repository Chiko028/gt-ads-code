package gtads.device

/** Darstellbarer Zustand der Registrierungsoberflaeche; nie Rohdaten. */
sealed interface RegistrationScreenState {
    data object Loading : RegistrationScreenState
    data object NotRegistered : RegistrationScreenState
    data object InProgress : RegistrationScreenState
    data class Registered(val deviceId: String, val serverUrl: String) : RegistrationScreenState
    data class Message(val messageRes: Int) : RegistrationScreenState
}
