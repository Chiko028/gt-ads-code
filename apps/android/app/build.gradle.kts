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
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.13")
}
