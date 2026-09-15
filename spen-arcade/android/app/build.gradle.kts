plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.spenarcade"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.spenarcade"
        // S Pen Remote SDK требует Android 10+ (Note10 и новее)
        minSdk = 29
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.activity:activity:1.9.2")
    implementation("androidx.core:core-ktx:1.13.1")

    // Samsung Pen Remote SDK.
    // Скачивается с developer.samsung.com/galaxy-spen-remote и кладётся в app/libs/.
    // Maven-артефакта у Samsung нет — только AAR из архива SDK.
    implementation(files("libs/spen-remote-v1.0.1.aar"))
}
