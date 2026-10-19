package ru.agility.videoszhatie

import android.content.ContentValues
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.OptIn
import androidx.core.content.FileProvider
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.Presentation
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Сжатие видео тренировок перед отправкой в ВК / Яндекс Диск.
 * Видео пережимается на телефоне (аппаратный кодек H.264) до 720p или 1080p,
 * затем его можно отправить через стандартное меню «Поделиться» или сохранить в галерею.
 */
@OptIn(UnstableApi::class)
class MainActivity : ComponentActivity() {

    /** Качество: короткая сторона кадра и целевой битрейт. */
    private enum class Quality(val label: String, val shortSide: Int, val bitrate: Int) {
        Q720("720p — компактно (≈ 20 МБ/мин)", 720, 2_500_000),
        Q1080("1080p — для разбора (≈ 40 МБ/мин)", 1080, 5_000_000),
    }

    private val ink = Color.parseColor("#14213D")
    private val accent = Color.parseColor("#1D4ED8")
    private val contact = Color.parseColor("#F5B700")
    private val muted = Color.parseColor("#5B6780")

    private lateinit var status: TextView
    private lateinit var details: TextView
    private lateinit var progress: ProgressBar
    private lateinit var pickBtn: Button
    private lateinit var cancelBtn: Button
    private lateinit var shareBtn: Button
    private lateinit var saveBtn: Button
    private lateinit var qualityGroup: RadioGroup

    private var transformer: Transformer? = null
    private var outputFile: File? = null
    private var inputSize: Long = 0
    private val handler = Handler(Looper.getMainLooper())
    private val progressHolder = ProgressHolder()

    private val pickVideo =
        registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
            if (uri != null) startCompression(uri)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
        handleShareIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleShareIntent(intent)
    }

    /** Видео пришло из галереи через «Поделиться → Сжатие видео». */
    private fun handleShareIntent(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND) return
        val uri: Uri? = if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(Intent.EXTRA_STREAM)
        }
        if (uri != null) startCompression(uri)
    }

    // ---------------------------------------------------------------- сжатие

    private fun selectedQuality(): Quality =
        if (qualityGroup.checkedRadioButtonId == Quality.Q1080.ordinal + 1) Quality.Q1080 else Quality.Q720

    private fun startCompression(uri: Uri) {
        if (transformer != null) {
            Toast.makeText(this, "Дождитесь окончания текущего сжатия", Toast.LENGTH_SHORT).show()
            return
        }
        val quality = selectedQuality()
        getSharedPreferences("settings", MODE_PRIVATE).edit().putInt("quality", quality.ordinal).apply()

        val info = readVideoInfo(uri)
        if (info == null) {
            showError("Не удалось прочитать видео. Попробуйте выбрать файл ещё раз.")
            return
        }
        inputSize = querySize(uri)

        // Короткую сторону приводим к 720/1080, не увеличивая маленькие видео.
        val shortSide = min(info.displayWidth, info.displayHeight)
        val longSide = max(info.displayWidth, info.displayHeight)
        val targetShort = min(quality.shortSide, shortSide)
        val scale = targetShort.toDouble() / shortSide
        val isPortrait = info.displayHeight >= info.displayWidth
        var targetHeight = if (isPortrait) (longSide * scale).roundToInt() else targetShort
        targetHeight -= targetHeight % 2 // кодеки любят чётные размеры

        // Битрейт не выше исходного: незачем «раздувать» уже лёгкое видео.
        val bitrate = if (info.bitrate in 1 until quality.bitrate) info.bitrate else quality.bitrate

        val dir = File(cacheDir, "compressed").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() } // старые результаты больше не нужны
        val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
        val out = File(dir, "agility_$stamp.mp4")
        outputFile = out

        val encoderFactory = DefaultEncoderFactory.Builder(this)
            .setRequestedVideoEncoderSettings(
                VideoEncoderSettings.Builder().setBitrate(bitrate).build()
            )
            .setEnableFallback(true)
            .build()

        val t = Transformer.Builder(this)
            .setVideoMimeType(MimeTypes.VIDEO_H264)
            .setAudioMimeType(MimeTypes.AUDIO_AAC)
            .setEncoderFactory(encoderFactory)
            .addListener(object : Transformer.Listener {
                override fun onCompleted(composition: Composition, exportResult: ExportResult) {
                    onDone(out)
                }

                override fun onError(
                    composition: Composition,
                    exportResult: ExportResult,
                    exportException: ExportException,
                ) {
                    finishWork()
                    out.delete()
                    showError("Не получилось сжать: ${exportException.errorCodeName}. Попробуйте качество 720p.")
                }
            })
            .build()

        val item = EditedMediaItem.Builder(MediaItem.fromUri(uri))
            .setEffects(Effects(emptyList(), listOf(Presentation.createForHeight(targetHeight))))
            .build()

        transformer = t
        setWorking(true)
        status.text = "Сжимаю видео…"
        details.text = "Исходник: ${info.displayWidth}×${info.displayHeight}, ${formatSize(inputSize)}, " +
            "${formatDuration(info.durationMs)}\nЦель: ${quality.shortSide}p, ${bitrate / 1000} кбит/с"
        t.start(item, out.absolutePath)
        handler.post(progressTick)
    }

    private val progressTick = object : Runnable {
        override fun run() {
            val t = transformer ?: return
            if (t.getProgress(progressHolder) == Transformer.PROGRESS_STATE_AVAILABLE) {
                progress.isIndeterminate = false
                progress.progress = progressHolder.progress
                status.text = "Сжимаю видео… ${progressHolder.progress}%"
            }
            handler.postDelayed(this, 500)
        }
    }

    private fun onDone(out: File) {
        finishWork()
        val size = out.length()
        val saved = if (inputSize > 0) 100 - (size * 100 / inputSize) else 0
        status.text = "Готово!"
        details.text = "Было ${formatSize(inputSize)} → стало ${formatSize(size)}" +
            (if (saved > 0) " (меньше на $saved%)" else "") +
            "\nНажмите «Отправить» и выберите ВКонтакте или Яндекс Диск."
        shareBtn.visibility = View.VISIBLE
        saveBtn.visibility = View.VISIBLE
    }

    private fun cancelCompression() {
        transformer?.cancel()
        outputFile?.delete()
        finishWork()
        status.text = "Сжатие отменено"
        details.text = ""
    }

    private fun finishWork() {
        handler.removeCallbacks(progressTick)
        transformer = null
        setWorking(false)
    }

    private fun setWorking(working: Boolean) {
        progress.visibility = if (working) View.VISIBLE else View.GONE
        progress.isIndeterminate = true
        cancelBtn.visibility = if (working) View.VISIBLE else View.GONE
        pickBtn.isEnabled = !working
        for (i in 0 until qualityGroup.childCount) qualityGroup.getChildAt(i).isEnabled = !working
        if (working) {
            shareBtn.visibility = View.GONE
            saveBtn.visibility = View.GONE
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    // ---------------------------------------------------------------- результат

    private fun shareResult() {
        val file = outputFile?.takeIf { it.exists() } ?: return
        val uri = FileProvider.getUriForFile(this, "$packageName.files", file)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "video/mp4"
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivity(Intent.createChooser(send, "Отправить видео"))
    }

    private fun saveToGallery() {
        val file = outputFile?.takeIf { it.exists() } ?: return
        val values = ContentValues().apply {
            put(MediaStore.Video.Media.DISPLAY_NAME, file.name)
            put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
            put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/Аджилити")
            put(MediaStore.Video.Media.IS_PENDING, 1)
        }
        val collection = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val target = contentResolver.insert(collection, values)
        if (target == null) {
            showError("Не удалось сохранить в галерею.")
            return
        }
        try {
            contentResolver.openOutputStream(target)?.use { os -> file.inputStream().use { it.copyTo(os) } }
            values.clear()
            values.put(MediaStore.Video.Media.IS_PENDING, 0)
            contentResolver.update(target, values, null, null)
            Toast.makeText(this, "Сохранено в папку Movies/Аджилити", Toast.LENGTH_LONG).show()
        } catch (e: Exception) {
            contentResolver.delete(target, null, null)
            showError("Не удалось сохранить в галерею: ${e.message}")
        }
    }

    // ---------------------------------------------------------------- данные о видео

    private data class VideoInfo(val displayWidth: Int, val displayHeight: Int, val bitrate: Int, val durationMs: Long)

    private fun readVideoInfo(uri: Uri): VideoInfo? {
        val r = MediaMetadataRetriever()
        return try {
            r.setDataSource(this, uri)
            val w = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: return null
            val h = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: return null
            val rot = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
            val br = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITRATE)?.toIntOrNull() ?: 0
            val dur = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
            val rotated = rot == 90 || rot == 270
            VideoInfo(if (rotated) h else w, if (rotated) w else h, br, dur)
        } catch (e: Exception) {
            null
        } finally {
            r.release()
        }
    }

    private fun querySize(uri: Uri): Long =
        try {
            contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else 0L
            } ?: 0L
        } catch (e: Exception) {
            0L
        }

    private fun formatSize(bytes: Long): String = when {
        bytes <= 0 -> "?"
        bytes >= 1L shl 30 -> String.format(Locale("ru"), "%.2f ГБ", bytes / 1073741824.0)
        else -> String.format(Locale("ru"), "%.1f МБ", bytes / 1048576.0)
    }

    private fun formatDuration(ms: Long): String {
        val s = ms / 1000
        return "%d:%02d".format(s / 60, s % 60)
    }

    private fun showError(msg: String) {
        status.text = "Ошибка"
        details.text = msg
    }

    // ---------------------------------------------------------------- интерфейс

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).roundToInt()

    private fun button(text: String, filled: Boolean, onClick: () -> Unit) = Button(this).apply {
        this.text = text
        isAllCaps = false
        textSize = 16f
        setTextColor(if (filled) Color.WHITE else accent)
        background = GradientDrawable().apply {
            cornerRadius = dp(10).toFloat()
            if (filled) setColor(accent) else { setColor(Color.TRANSPARENT); setStroke(dp(2), accent) }
        }
        setPadding(dp(16), dp(14), dp(16), dp(14))
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            .apply { topMargin = dp(12) }
    }

    private fun buildUi(): View {
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(ink)
            setPadding(dp(20), dp(28), dp(20), dp(20))
            addView(View(context).apply {
                background = GradientDrawable(
                    GradientDrawable.Orientation.LEFT_RIGHT,
                    intArrayOf(contact, Color.WHITE, contact, Color.WHITE)
                ).apply { cornerRadius = dp(3).toFloat() }
                layoutParams = LinearLayout.LayoutParams(dp(48), dp(10))
            })
            addView(TextView(context).apply {
                text = "Сжатие видео"
                textSize = 24f
                setTypeface(typeface, Typeface.BOLD)
                setTextColor(Color.WHITE)
                setPadding(0, dp(10), 0, 0)
            })
            addView(TextView(context).apply {
                text = "Тренировки — в ВК и на Яндекс Диск без лишних гигабайт"
                textSize = 14f
                setTextColor(Color.parseColor("#C9D2E3"))
            })
        }

        val saved = getSharedPreferences("settings", MODE_PRIVATE).getInt("quality", 0)
        qualityGroup = RadioGroup(this).apply {
            orientation = RadioGroup.VERTICAL
            Quality.entries.forEach { q ->
                addView(RadioButton(context).apply {
                    id = q.ordinal + 1
                    text = q.label
                    textSize = 16f
                    setTextColor(ink)
                    setPadding(dp(4), dp(8), 0, dp(8))
                })
            }
            check((Quality.entries.getOrNull(saved) ?: Quality.Q720).ordinal + 1)
        }

        status = TextView(this).apply {
            text = "Выберите видео или отправьте его сюда из галереи через «Поделиться»."
            textSize = 17f
            setTextColor(ink)
            setTypeface(typeface, Typeface.BOLD)
            setPadding(0, dp(20), 0, 0)
        }
        details = TextView(this).apply { textSize = 14f; setTextColor(muted); setPadding(0, dp(6), 0, 0) }
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            visibility = View.GONE
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(12)).apply { topMargin = dp(12) }
        }

        pickBtn = button("Выбрать видео", true) {
            pickVideo.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.VideoOnly))
        }
        cancelBtn = button("Отменить", false) { cancelCompression() }.apply { visibility = View.GONE }
        shareBtn = button("Отправить (ВК, Яндекс Диск…)", true) { shareResult() }.apply { visibility = View.GONE }
        saveBtn = button("Сохранить в галерею", false) { saveToGallery() }.apply { visibility = View.GONE }

        val body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(16), dp(20), dp(32))
            addView(TextView(context).apply {
                text = "Качество"
                textSize = 13f
                setTextColor(muted)
                isAllCaps = true
                letterSpacing = 0.06f
            })
            addView(qualityGroup)
            addView(pickBtn)
            addView(status)
            addView(details)
            addView(progress)
            addView(cancelBtn)
            addView(shareBtn)
            addView(saveBtn)
        }

        return ScrollView(this).apply {
            setBackgroundColor(Color.parseColor("#F3F5F8"))
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.TOP
                addView(header)
                addView(body)
            })
        }
    }

    override fun onDestroy() {
        handler.removeCallbacks(progressTick)
        if (isFinishing) transformer?.cancel()
        super.onDestroy()
    }
}
