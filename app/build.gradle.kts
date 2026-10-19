plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ru.agility.videoszhatie"
    compileSdk = 35

    defaultConfig {
        applicationId = "ru.agility.videoszhatie"
        minSdk = 24          // Android 7+
        targetSdk = 35
        versionCode = 3
        versionName = "2.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    lint {
        abortOnError = false
    }
}

dependencies {
    val media3 = "1.5.1"
    implementation("androidx.media3:media3-transformer:$media3")
    implementation("androidx.media3:media3-effect:$media3")
    implementation("androidx.media3:media3-common:$media3")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
