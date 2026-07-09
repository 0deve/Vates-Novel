import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Release signing
val keystoreProperties = Properties().apply {
    val propFile = rootProject.file("keystore.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    namespace = "com.stefan.desktop_novel"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.stefan.desktop_novel"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        if (keystoreProperties.containsKey("storeFile")) {
            create("release") {
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["password"] as String
                storeFile = rootProject.file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["password"] as String
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}


base {
    archivesName.set("vates_novel")
}

rust {
    rootDirRel = "../../../"
}

// The Rust TTS engine verifies TLS through Android's trust store
// (rustls-platform-verifier), which needs its Kotlin component packaged in
// the APK. The AAR ships inside the rustls-platform-verifier-android crate
// as a local maven repo; locate it via cargo metadata so the path and
// version always track Cargo.lock.
val rustlsPlatformVerifier: Pair<String, String> = run {
    val metadataJson = providers.exec {
        commandLine(
            "cargo", "metadata", "--format-version", "1",
            "--manifest-path", file("../../../Cargo.toml").absolutePath,
        )
    }.standardOutput.asText.get()

    @Suppress("UNCHECKED_CAST")
    val packages = (groovy.json.JsonSlurper()
        .parseText(metadataJson) as Map<String, Any?>)["packages"] as List<Map<String, Any?>>
    val pkg = packages.first { it["name"] == "rustls-platform-verifier-android" }
    val mavenDir = File(File(pkg["manifest_path"] as String).parentFile, "maven")
    Pair(mavenDir.path, pkg["version"] as String)
}

repositories {
    maven { url = uri(rustlsPlatformVerifier.first) }
}

dependencies {
    implementation("rustls:rustls-platform-verifier:${rustlsPlatformVerifier.second}")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    // MediaSessionCompat + MediaStyle for the TTS playback notification.
    implementation("androidx.media:media:1.7.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")