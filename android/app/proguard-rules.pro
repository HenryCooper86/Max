# Release builds currently ship without R8 (isMinifyEnabled = false in
# app/build.gradle.kts), so this file is not applied yet. Before turning R8 on:
#
# 1. Add the AMap SDK keep rules from its integration guide (the
#    com.amap.api / com.autonavi classes are reached through JNI and
#    reflection and ship no consumer rules).
# 2. Build the minified release APK and run the full device acceptance on it:
#    voice session over ws:// and wss://, Bluetooth headset routing, map tiles,
#    photo/video capture, gallery describe, music, crash check-in and alarm,
#    RDK pairing and HUD casting. Missing-class crashes only show at runtime.
# 3. Keep the generated mapping.txt for every published versionCode so crash
#    reports can be de-obfuscated.
#
# OkHttp, kotlinx-coroutines, CameraX and AndroidX ship their own consumer
# rules; org.json is part of the platform.
