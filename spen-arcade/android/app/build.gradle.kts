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

    buildTypes {
        release {
            isMinifyEnabled = false
            // Подписываем debug-ключом, чтобы release-APK ставился без возни
            // с keystore. Для публикации в Play ключ, разумеется, нужен свой.
            signingConfig = signingConfigs.getByName("debug")
        }
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
    implementation("androidx.appcompat:appcompat:1.7.0")

    // Samsung Pen Remote SDK — ОПЦИОНАЛЬНО.
    // Если положить spen-remote-*.aar в app/libs/, включится управление
    // наклоном в воздухе (Air Actions). Без него APK всё равно собирается,
    // а игра работает на hover-наклоне: SPenBridge обращается к SDK
    // через рефлексию и корректно переживает его отсутствие.
    implementation(fileTree("libs") { include("*.aar") })
}

// Веб-часть живёт отдельным npm-проектом. Копируем её сборку в assets перед
// каждым билдом и падаем с понятным сообщением, если её забыли собрать —
// иначе приложение просто запустится с чёрным экраном, и причина неочевидна.
val webDist = rootProject.file("../web/dist/index.html")

val copyWebBuild by tasks.registering(Copy::class) {
    doFirst {
        if (!webDist.exists()) {
            throw GradleException(
                "Не найдена сборка игры: ${webDist.path}\n" +
                "Сначала выполни:  cd spen-arcade/web && npm ci && npm run build"
            )
        }
    }
    from(webDist)
    into(layout.projectDirectory.dir("src/main/assets/game"))
}

tasks.named("preBuild") { dependsOn(copyWebBuild) }
