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

val horizonGitCommitRaw = (providers.environmentVariable("HORIZON_GIT_COMMIT").orNull
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
val horizonGitCommit = if (horizonGitCommitRaw.matches(Regex("^[0-9a-fA-F]{7,40}$"))) {
    horizonGitCommitRaw.take(12).lowercase()
} else {
    horizonGitCommitRaw
}

android {
    namespace = "com.horizon.maxhelmet"
    compileSdk {
        version = release(36) {
            minorApiLevel = 1
        }
    }

    defaultConfig {
        applicationId = "com.horizon.maxhelmet"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "com.horizon.maxhelmet.agent.SyntheticQaInstrumentation"
        buildConfigField("String", "GIT_COMMIT", "\"$horizonGitCommit\"")
        buildConfigField("String", "AMAP_ANDROID_KEY", "\"${amapAndroidKey.replace("\\", "\\\\").replace("\"", "\\\"")}\"")
    }

    buildTypes {
        release {
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
    implementation("androidx.exifinterface:exifinterface:1.3.7")
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
