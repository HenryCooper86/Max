plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

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
    compileSdk = 34

    defaultConfig {
        applicationId = "com.horizon.maxhelmet"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("String", "GIT_COMMIT", "\"$horizonGitCommit\"")
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
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
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
}
