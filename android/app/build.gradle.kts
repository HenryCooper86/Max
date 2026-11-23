import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

val localConfig = Properties().apply {
    rootProject.file("local.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) }
}
val amapAndroidKey = providers.environmentVariable("AMAP_ANDROID_KEY").orNull
    ?: localConfig.getProperty("amap.android.key", "")

val maxGitCommitRaw = (providers.environmentVariable("MAX_GIT_COMMIT").orNull
    ?.trim()
    ?.takeIf { it.isNotEmpty() }
    ?: runCatching {
            providers.exec {
                workingDir(rootProject.projectDir.parentFile)
                commandLine("git", "rev-parse", "--short=12", "HEAD")
                isIgnoreExitValue = true
            }.standardOutput.asText.get().trim()
        }
        .getOrDefault("unknown"))
    .filter { it.isLetterOrDigit() || it == '.' || it == '_' || it == '-' }
    .take(80)
    .ifEmpty { "unknown" }
val maxGitCommit = if (maxGitCommitRaw.matches(Regex("^[0-9a-fA-F]{7,40}$"))) {
    maxGitCommitRaw.take(12).lowercase()
} else {
    maxGitCommitRaw
}

// CI passes a monotonically increasing build number with -PversionCode=; local
// builds default to 1. A malformed value fails the build instead of silently
// shipping an APK that cannot upgrade the installed one.
val maxVersionCode = providers.gradleProperty("versionCode").orNull?.trim()?.let { raw ->
    raw.toIntOrNull()?.takeIf { it in 1..2_100_000_000 }
        ?: throw GradleException("-PversionCode must be an integer between 1 and 2100000000, got '$raw'")
} ?: 1

// Release signing is optional: with none of these set, assembleRelease still
// produces an unsigned APK (the CI default). Each value comes from a Gradle
// property (-P or ~/.gradle/gradle.properties) or the matching environment
// variable, so keystore secrets never need to live in the repository.
fun releaseSigningValue(property: String, environment: String): String? =
    (providers.gradleProperty(property).orNull ?: providers.environmentVariable(environment).orNull)
        ?.takeIf { it.isNotBlank() }
val releaseSigning = mapOf(
    "storeFile" to releaseSigningValue("maxReleaseStoreFile", "MAX_RELEASE_STORE_FILE"),
    "storePassword" to releaseSigningValue("maxReleaseStorePassword", "MAX_RELEASE_STORE_PASSWORD"),
    "keyAlias" to releaseSigningValue("maxReleaseKeyAlias", "MAX_RELEASE_KEY_ALIAS"),
    "keyPassword" to releaseSigningValue("maxReleaseKeyPassword", "MAX_RELEASE_KEY_PASSWORD")
)
val releaseSigningConfigured = releaseSigning.values.all { it != null }
if (!releaseSigningConfigured && releaseSigning.values.any { it != null }) {
    // Half a configuration is a mistake, not a request for an unsigned build.
    val missing = releaseSigning.filterValues { it == null }.keys.joinToString()
    throw GradleException("Release signing is partly configured; missing: $missing")
}

android {
    namespace = "io.github.henrycooper86.max"
    compileSdk {
        version = release(36) {
            minorApiLevel = 1
        }
    }

    defaultConfig {
        applicationId = "io.github.henrycooper86.max"
        minSdk = 26
        targetSdk = 36
        versionCode = maxVersionCode
        // Matches the iOS marketing version.
        versionName = "1.0.0"
        testInstrumentationRunner = "io.github.henrycooper86.max.agent.SyntheticQaInstrumentation"
        buildConfigField("String", "GIT_COMMIT", "\"$maxGitCommit\"")
        buildConfigField("String", "AMAP_ANDROID_KEY", "\"${amapAndroidKey.replace("\\", "\\\\").replace("\"", "\\\"")}\"")
    }

    signingConfigs {
        if (releaseSigningConfigured) {
            create("release") {
                val keystore = file(releaseSigning.getValue("storeFile")!!)
                if (!keystore.isFile) throw GradleException("Release keystore not found: $keystore")
                storeFile = keystore
                storePassword = releaseSigning.getValue("storePassword")
                keyAlias = releaseSigning.getValue("keyAlias")
                keyPassword = releaseSigning.getValue("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            if (releaseSigningConfigured) signingConfig = signingConfigs.getByName("release")
            // R8 stays off until the checks listed in proguard-rules.pro pass.
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    // Reuse the canonical safety clips directly; no duplicated binary source files.
    sourceSets.getByName("main").assets.srcDir(rootProject.file("../public/audio"))
}

dependencies {
    // The maintained AMap artifact bundles location/search; we use map APIs only.
    implementation("com.amap.api:3dmap-location-search:11.2.100_loc11.2.100_sea9.8.1")
    implementation("androidx.camera:camera-camera2:1.4.2")
    implementation("androidx.camera:camera-lifecycle:1.4.2")
    implementation("androidx.camera:camera-video:1.4.2")
    implementation(libs.androidx.exifinterface)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.coroutines.android)
    testImplementation(libs.junit)
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
    // Test-only: the unit-test android.jar's org.json.* classes are throwing
    // stubs (Robolectric-less JVM unit tests get "not mocked" RuntimeExceptions
    // on JSONObject.put/optString/... ). This shadows those stubs with the real
    // implementation so parseAgentEvent/buildNavRequest/etc. can be unit tested
    // directly. Never reaches the production classpath. Authorized exception,
    // plan Tech Stack line (2026-08-08-nav-android-plan-c), Task 3.
    testImplementation("org.json:json:20231013")
}
