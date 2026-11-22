plugins {
    id("com.android.application") version "8.7.3"
    id("org.jetbrains.kotlin.android") version "2.0.21"
}

android {
    namespace = "gtads.device"
    compileSdk = 35

    defaultConfig {
        applicationId = "gtads.device"
        minSdk = 26
        targetSdk = 35
        // Pflicht: Registrierung und Heartbeat senden app_version; ohne versionName
        // war sie leer und der Server lehnte die Registrierung als ungueltig ab.
        versionCode = 1
        versionName = "0.1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
        }
    }
}

// WorkManager 2.9.1 ist im Offline-Cache des Runners nicht vorhanden und
// ohne Netz nicht aufloesbar; die API-kompatible Minimalimplementierung
// liegt unter src/main/java/androidx/work.
dependencies {
    // Media3 wird mit seinen Transitiven gebunden: media3-exoplayer benoetigt
    // zur Laufzeit datasource/decoder/extractor sowie Guava (ListenableFuture,
    // auch von WorkManager vorausgesetzt), media3-ui benoetigt RecyclerView.
    // Alle diese Artefakte liegen in der Offline-Versorgung.
    implementation("androidx.media3:media3-common:1.4.1")
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    implementation("androidx.media3:media3-ui:1.4.1")

    implementation("androidx.work:work-runtime:2.9.1")
    constraints {
        // Offline-Versorgung enthaelt neuere, kompatible Versionen der WorkManager-Transitiven.
        implementation("androidx.annotation:annotation-experimental:1.4.0")
        implementation("androidx.core:core:1.13.1")
        implementation("androidx.lifecycle:lifecycle-livedata:2.8.7")
        implementation("androidx.lifecycle:lifecycle-service:2.8.7")
        implementation("androidx.room:room-ktx:2.6.1")
        implementation("androidx.room:room-runtime:2.6.1")
        implementation("androidx.sqlite:sqlite-framework:2.4.0")
        implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
        implementation("androidx.collection:collection:1.2.0")
        implementation("com.google.guava:listenablefuture:9999.0-empty-to-avoid-conflict-with-guava")
    }
    testImplementation("androidx.work:work-testing:2.9.1")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.13")
}



