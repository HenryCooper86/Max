// Top-level build file. Per-module configuration lives in app/build.gradle.kts.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.compose) apply false
}

// Lock the buildscript classpath (AGP + Kotlin plugin and their transitive deps)
// so osv-scanner can audit build-time dependencies too. Regenerate together with
// the module locks: ./gradlew ... --write-locks
buildscript {
    dependencies {
        constraints {
            classpath("com.google.guava:guava:33.8.0-jre") {
                because("GHSA-xxph-c9ww-hj94: guava < 33.7.2; AGP/Kotlin plugin transitive dep is 33.4.0-jre")
            }
            classpath("org.apache.commons:commons-lang3:3.22.0") {
                because("GHSA-j288-q9x7-2f5v: commons-lang3 < 3.18.0; AGP transitive dep is 3.16.0")
            }
            classpath("org.bitbucket.b_c:jose4j:0.9.7") {
                because("GHSA-3677-xxcr-wjqv: jose4j < 0.9.6; AGP transitive dep is 0.9.5")
            }
            classpath("org.bouncycastle:bcprov-jdk18on:1.87") {
                because("GHSA-9pwp-9qqc-pr26, GHSA-qp49-qgx5-5m26: bcprov < 1.85; AGP transitive dep is 1.80.2")
            }
            classpath("org.bouncycastle:bcpkix-jdk18on:1.87") {
                because("GHSA-wg6q-6289-32hp: bcpkix < 1.84; AGP transitive dep is 1.80.2")
            }
            classpath("org.jdom:jdom2:2.0.6.1") {
                because("GHSA-2363-cqg2-863c: jdom2 < 2.0.6.1; AGP transitive dep is 2.0.6")
            }
        }
    }
    configurations.classpath {
        resolutionStrategy {
            activateDependencyLocking()
        }
    }
}
