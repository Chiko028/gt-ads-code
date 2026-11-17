package gtads.device.playback

import androidx.media3.common.Player

/**
 * Optionale sichtbare Oberflaeche der lokalen Wiedergabe. Der Player-Port kennt
 * nur diese schmale Schnittstelle; die Media3-Klassen bleiben in
 * [createMedia3PlaybackSurface] gekapselt und werden erst im Produktivpfad
 * geladen.
 */
internal interface PlaybackSurface {
    fun bindPlayer(player: Player?)
}
