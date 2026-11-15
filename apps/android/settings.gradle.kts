import org.gradle.api.Action
import org.gradle.api.Project

// Robolectric bringt fuer die Unit-Tests AndroidX-Artefakte mit. Der
// vorgegebene Lieferumfang erlaubt als lokale Gradle-Dateien nur diese
// Datei und app/build.gradle.kts; die dafuer noetige Eigenschaft wird
// deshalb hier gesetzt. Die Abweichung ist mit dem Betreiber zu klaeren.
gradle.beforeProject(object : Action<Project> {
    override fun execute(project: Project) {
        project.extensions.extraProperties.set("android.useAndroidX", "true")
    }
})

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "gt-ads-android"
include(":app")
