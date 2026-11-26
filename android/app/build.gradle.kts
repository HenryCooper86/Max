import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

// Pin the full dependency graph so osv-scanner can audit it without Dependabot.
// Any dependency upgrade must regenerate the locks: ./gradlew ... --write-locks
dependencyLocking {
    lockAllConfigurations()
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

// The release workflow passes the kit's version with -PversionName= (the tag
// without its `v`, which the workflow checks against package.json). Local and
// pull-request builds keep the default, the iOS marketing version.
val maxVersionName = providers.gradleProperty("versionName").orNull?.trim()?.takeIf { it.isNotEmpty() } ?: "1.0.0"

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
        version = release(37) {
            minorApiLevel = 2
        }
    }

    defaultConfig {
        applicationId = "io.github.henrycooper86.max"
        minSdk = 26
        targetSdk = 36
        versionCode = maxVersionCode
        // The default matches the iOS marketing version.
        versionName = maxVersionName
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
    testOptions {
        // Robolectric tests start the real app: the HUD needs the merged manifest and resources.
        unitTests.isIncludeAndroidResources = true
        // A failure on CI should say why, not only the line it was at.
        unitTests.all {
            it.testLogging {
                events("failed")
                exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
            }
        }
    }
    // Reuse the canonical safety clips directly; no duplicated binary source files.
    sourceSets.getByName("main").assets.srcDir(rootProject.file("../public/audio"))
}

dependencies {
    // The maintained AMap artifact bundles location/search; we use map APIs only.
    implementation("com.amap.api:3dmap-location-search:11.3.100_loc11.3.101_sea9.8.1")
    implementation("androidx.camera:camera-camera2:1.7.0")
    implementation("androidx.camera:camera-lifecycle:1.7.0")
    implementation("androidx.camera:camera-video:1.7.0")
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
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
    // JVM-run app start path (MainActivity + MainViewModel under Robolectric, no emulator).
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.test.ext.junit)
    // Test-only: the unit-test android.jar's org.json.* classes are throwing
    // stubs (Robolectric-less JVM unit tests get "not mocked" RuntimeExceptions
    // on JSONObject.put/optString/... ). This shadows those stubs with the real
    // implementation so parseAgentEvent/buildNavRequest/etc. can be unit tested
    // directly. Never reaches the production classpath. Authorized exception,
    // plan Tech Stack line (2026-08-08-nav-android-plan-c), Task 3.
    testImplementation("org.json:json:20260814")

    // Transitive versions pinned to the latest fixed releases; osv-scanner reads the
    // lockfiles these feed. Regenerate with `./gradlew ... --write-locks` after changing.
    constraints {
        // App runtime/compile classpaths: the AMap SDK pulls an old guava -android build.
        implementation("com.google.guava:guava:33.8.0-android") {
            because("GHSA-xxph-c9ww-hj94: guava < 33.7.2; AMap 3dmap-location-search brings 33.3.1-android (32.0.1-android at compile time)")
        }
        // Test-only (Robolectric) transitive deps, never shipped in the APK.
        testImplementation("com.google.guava:guava:33.8.0-jre") {
            because("GHSA-xxph-c9ww-hj94: guava < 33.7.2; keep the JVM test runtime on the fixed -jre build")
        }
        testImplementation("org.apache.commons:commons-lang3:3.22.0") {
            because("GHSA-j288-q9x7-2f5v: commons-lang3 < 3.18.0; Robolectric brings 3.16.0")
        }
        testImplementation("org.apache.httpcomponents:httpclient:4.5.14") {
            because("GHSA-7r82-7xv7-xcpj: httpclient < 4.5.13; Robolectric brings 4.5.6")
        }
        testImplementation("org.bouncycastle:bcprov-jdk18on:1.87") {
            because("GHSA-9pwp-9qqc-pr26, GHSA-qp49-qgx5-5m26: bcprov < 1.85; Robolectric brings 1.80.2")
        }
        testImplementation("org.bouncycastle:bcpkix-jdk18on:1.87") {
            because("GHSA-wg6q-6289-32hp: bcpkix < 1.84; Robolectric brings 1.80.2")
        }
        testImplementation("org.bouncycastle:bcutil-jdk18on:1.87") {
            because("Align bcutil with the fixed bcprov/bcpkix pulled by Robolectric")
        }
        // Lint tooling (androidLintTool), build-time only.
        add("androidLintTool", "com.google.guava:guava:33.8.0-jre") {
            because("GHSA-xxph-c9ww-hj94: guava < 33.7.2; AGP lint tool brings 33.4.0-jre")
        }
        add("androidLintTool", "org.apache.commons:commons-lang3:3.22.0") {
            because("GHSA-j288-q9x7-2f5v: commons-lang3 < 3.18.0; AGP lint tool brings 3.16.0")
        }
        add("androidLintTool", "org.apache.httpcomponents:httpclient:4.5.14") {
            because("GHSA-7r82-7xv7-xcpj: httpclient < 4.5.13; AGP lint tool brings 4.5.6")
        }
        add("androidLintTool", "org.bouncycastle:bcprov-jdk18on:1.87") {
            because("GHSA-9pwp-9qqc-pr26, GHSA-qp49-qgx5-5m26: bcprov < 1.85; AGP lint tool brings 1.80.2")
        }
        add("androidLintTool", "org.bouncycastle:bcpkix-jdk18on:1.87") {
            because("GHSA-wg6q-6289-32hp: bcpkix < 1.84; AGP lint tool brings 1.80.2")
        }
        add("androidLintTool", "org.bouncycastle:bcutil-jdk18on:1.87") {
            because("Align bcutil with the fixed bcprov/bcpkix pulled by the AGP lint tool")
        }
    }
}
