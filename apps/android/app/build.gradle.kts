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
        // App-Updates: Jede ausgelieferte Version braucht einen hoeheren versionCode
        // und einen eigenen versionName. Beim Bau ueberschreibbar:
        //   gradle assembleRelease -PgtadsVersionCode=3 -PgtadsVersionName=0.3.0
        versionCode = (project.findProperty("gtadsVersionCode") as String?)?.toInt() ?: 2
        versionName = (project.findProperty("gtadsVersionName") as String?) ?: "0.2.0"
    }

    // App-Updates: Android nimmt Updates nur mit demselben Signaturschluessel an.
    // Der Release-Schluessel liegt ausserhalb des Repos; ohne Angaben entsteht kein
    // signierter Release-Build (Debug-Builds bleiben unveraendert).
    val releaseStore = (project.findProperty("gtadsKeystore") as String?)?.let { file(it) }
    signingConfigs {
        if (releaseStore != null) {
            create("release") {
                storeFile = releaseStore
                storePassword = project.findProperty("gtadsKeystorePassword") as String?
                keyAlias = (project.findProperty("gtadsKeyAlias") as String?) ?: "gtads"
                keyPassword = (project.findProperty("gtadsKeyPassword") as String?)
                    ?: (project.findProperty("gtadsKeystorePassword") as String?)
            }
        }
    }
    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            if (releaseStore != null) signingConfig = signingConfigs.getByName("release")
        }
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



