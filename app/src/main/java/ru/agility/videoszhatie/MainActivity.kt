package ru.agility.videoszhatie

import android.Manifest
import android.app.AlertDialog
import android.app.DatePickerDialog
import android.content.ContentUris
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
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
import android.text.InputType
import android.util.Base64
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
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
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.FrameDropEffect
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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * «Сжатие видео» для клуба аджилити.
 *
 * 1. Тренировка → на сайт: выбираете дату, приложение находит все видео, снятые в этот день,
 *    сжимает их по очереди и загружает на сайт клуба (вкладка «Видео»).
 * 2. Одно видео: сжать и отправить через «Поделиться» (ВК, Яндекс Диск…) или сохранить в галерею.
 */
@OptIn(UnstableApi::class)
class MainActivity : ComponentActivity() {

    /** Качество: короткая сторона кадра и целевой битрейт. */
    private enum class Quality(val label: String, val shortSide: Int, val bitrate: Int) {
        ECO("720p экономно (≈ 9 МБ/мин) — для сайта", 720, 1_200_000),
        Q720("720p стандарт (≈ 19 МБ/мин)", 720, 2_500_000),
        Q1080("1080p для разбора (≈ 38 МБ/мин)", 1080, 5_000_000),
    }

    /** Видео из галереи за выбранный день. */
    private class Clip(
        val uri: Uri,
        val name: String,
        val size: Long,
        val durationMs: Long,
        val takenMs: Long,
    ) {
        lateinit var check: CheckBox
        lateinit var status: TextView
        var done = false
    }

    private val ink = Color.parseColor("#14213D")
    private val accent = Color.parseColor("#1D4ED8")
    private val contact = Color.parseColor("#F5B700")
    private val muted = Color.parseColor("#5B6780")
    private val okColor = Color.parseColor("#13804A")
    private val errColor = Color.parseColor("#B42318")

    private val prefs by lazy { getSharedPreferences("settings", MODE_PRIVATE) }
    private val handler = Handler(Looper.getMainLooper())

    // общие элементы
    private lateinit var qualityGroup: RadioGroup

    // тренировка → сайт
    private lateinit var dateBtn: Button
    private lateinit var dayInfo: TextView
    private lateinit var clipsBox: LinearLayout
    private lateinit var uploadBtn: Button
    private lateinit var dayProgress: ProgressBar
    private lateinit var dayStatus: TextView
    private lateinit var stopBtn: Button
    private var day: Calendar = Calendar.getInstance()
    private var clips: List<Clip> = emptyList()
    private var dayJob: Job? = null

    // одно видео
    private lateinit var status: TextView
    private lateinit var details: TextView
    private lateinit var progress: ProgressBar
    private lateinit var pickBtn: Button
    private lateinit var cancelBtn: Button
    private lateinit var shareBtn: Button
    private lateinit var saveBtn: Button
    private var singleJob: Job? = null
    private var outputFile: File? = null

    private val pickVideo =
        registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
            if (uri != null) startSingle(uri)
        }

    private val askMediaPermission =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { loadDay() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
        updateDateButton()
        handleShareIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleShareIntent(intent)
    }

    private fun handleShareIntent(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND) return
        val uri: Uri? = if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(Intent.EXTRA_STREAM)
        }
        if (uri != null) startSingle(uri)
    }

    private fun selectedQuality(): Quality =
        Quality.entries.firstOrNull { it.ordinal + 1 == qualityGroup.checkedRadioButtonId } ?: Quality.ECO

    private fun busy() = dayJob?.isActive == true || singleJob?.isActive == true

    private fun keepScreenOn(on: Boolean) {
        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    // ================================================================ тренировка → сайт

    private fun updateDateButton() {
        dateBtn.text = "Дата съёмки: " + SimpleDateFormat("d MMMM yyyy, EEEE", Locale("ru")).format(day.time)
    }

    private fun chooseDate() {
        if (busy()) return
        DatePickerDialog(this, { _, y, m, d ->
            day = Calendar.getInstance().apply { set(y, m, d, 0, 0, 0); set(Calendar.MILLISECOND, 0) }
            updateDateButton()
            loadDay()
        }, day.get(Calendar.YEAR), day.get(Calendar.MONTH), day.get(Calendar.DAY_OF_MONTH)).show()
    }

    private fun mediaPermissions(): Array<String> = when {
        Build.VERSION.SDK_INT >= 34 -> arrayOf(Manifest.permission.READ_MEDIA_VIDEO, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
        Build.VERSION.SDK_INT >= 33 -> arrayOf(Manifest.permission.READ_MEDIA_VIDEO)
        else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
    }

    private fun hasFullAccess(): Boolean {
        val p = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_VIDEO else Manifest.permission.READ_EXTERNAL_STORAGE
        return checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED
    }

    private fun hasPartialAccess(): Boolean =
        Build.VERSION.SDK_INT >= 34 &&
            checkSelfPermission(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) == PackageManager.PERMISSION_GRANTED

    private fun findVideosClicked() {
        if (busy()) return
        if (!hasFullAccess() && !hasPartialAccess()) {
            askMediaPermission.launch(mediaPermissions())
            return
        }
        loadDay()
    }

    /** Ищет в галерее все видео, снятые в выбранный день. */
    private fun loadDay() {
        if (!hasFullAccess() && !hasPartialAccess()) {
            dayInfo.text = "Нужно разрешение на доступ к видео. Нажмите «Найти видео» ещё раз и разрешите доступ."
            return
        }
        val start = day.timeInMillis
        val end = start + 24L * 3600 * 1000
        val found = mutableListOf<Clip>()
        val projection = arrayOf(
            MediaStore.Video.Media._ID,
            MediaStore.Video.Media.DISPLAY_NAME,
            MediaStore.Video.Media.SIZE,
            MediaStore.Video.Media.DURATION,
            MediaStore.Video.Media.DATE_TAKEN,
            MediaStore.Video.Media.DATE_ADDED,
        )
        val sel = "(${MediaStore.Video.Media.DATE_TAKEN} >= ? AND ${MediaStore.Video.Media.DATE_TAKEN} < ?) OR " +
            "((${MediaStore.Video.Media.DATE_TAKEN} IS NULL OR ${MediaStore.Video.Media.DATE_TAKEN} = 0) AND " +
            "${MediaStore.Video.Media.DATE_ADDED} >= ? AND ${MediaStore.Video.Media.DATE_ADDED} < ?)"
        val args = arrayOf(start.toString(), end.toString(), (start / 1000).toString(), (end / 1000).toString())
        try {
            contentResolver.query(
                MediaStore.Video.Media.EXTERNAL_CONTENT_URI, projection, sel, args,
                "${MediaStore.Video.Media.DATE_TAKEN} ASC",
            )?.use { c ->
                while (c.moveToNext()) {
                    val id = c.getLong(0)
                    val taken = c.getLong(4).takeIf { it > 0 } ?: (c.getLong(5) * 1000)
                    found += Clip(
                        uri = ContentUris.withAppendedId(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, id),
                        name = c.getString(1) ?: "video_$id.mp4",
                        size = c.getLong(2),
                        durationMs = c.getLong(3),
                        takenMs = taken,
                    )
                }
            }
        } catch (e: Exception) {
            dayInfo.text = "Не удалось прочитать галерею: ${e.message}"
            return
        }
        clips = found
        renderClips()
    }

    private fun renderClips() {
        clipsBox.removeAllViews()
        val partial = !hasFullAccess() && hasPartialAccess()
        if (clips.isEmpty()) {
            dayInfo.text = "За этот день видео не найдено." +
                if (partial) "\nПриложению разрешён доступ только к выбранным видео — разрешите доступ ко всем в настройках Android." else ""
            uploadBtn.visibility = View.GONE
            return
        }
        val total = clips.sumOf { it.size }
        dayInfo.text = "Найдено ${clips.size} видео, ${formatSize(total)}, " +
            "${formatDuration(clips.sumOf { it.durationMs })}. Снимите галочки с лишних." +
            if (partial) "\nВидны только видео, к которым вы дали доступ." else ""
        val tf = SimpleDateFormat("HH:mm", Locale("ru"))
        clips.forEach { clip ->
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(0, dp(6), 0, dp(6))
            }
            clip.check = CheckBox(this).apply {
                isChecked = true
                text = "${tf.format(Date(clip.takenMs))} · ${formatDuration(clip.durationMs)} · ${formatSize(clip.size)}"
                textSize = 15f
                setTextColor(ink)
                setOnCheckedChangeListener { _, _ -> updateUploadButton() }
            }
            clip.status = TextView(this).apply {
                textSize = 13f
                setTextColor(muted)
                setPadding(dp(32), 0, 0, 0)
                visibility = View.GONE
            }
            row.addView(clip.check)
            row.addView(clip.status)
            clipsBox.addView(row)
        }
        uploadBtn.visibility = View.VISIBLE
        updateUploadButton()
    }

    private fun updateUploadButton() {
        val n = clips.count { it.check.isChecked && !it.done }
        uploadBtn.text = "Сжать и загрузить на сайт ($n)"
        uploadBtn.isEnabled = n > 0 && !busy()
    }

    private fun startDayUpload() {
        if (busy()) return
        if (prefs.getString("login", "").isNullOrBlank() || prefs.getString("apppass", "").isNullOrBlank()) {
            Toast.makeText(this, "Сначала укажите вход на сайт", Toast.LENGTH_SHORT).show()
            showSettings()
            return
        }
        val queue = clips.filter { it.check.isChecked && !it.done }
        if (queue.isEmpty()) return
        val quality = selectedQuality()
        prefs.edit().putInt("quality2", quality.ordinal).apply()
        val date = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(day.time)
        val titleDate = SimpleDateFormat("d MMMM", Locale("ru")).format(day.time)
        val tf = SimpleDateFormat("HH:mm", Locale("ru"))

        dayJob = lifecycleScope.launch {
            setDayWorking(true)
            var ok = 0
            var sentBytes = 0L
            try {
                queue.forEachIndexed { i, clip ->
                    val prefix = "Видео ${i + 1} из ${queue.size}"
                    clip.status.visibility = View.VISIBLE
                    clip.status.setTextColor(muted)
                    val out = File(File(cacheDir, "upload").apply { mkdirs() }, "agility_${date}_${tf.format(Date(clip.takenMs)).replace(":", "")}_${i + 1}.mp4")
                    try {
                        // 1) сжатие
                        dayStatus.text = "$prefix: сжимаю…"
                        compress(clip.uri, out, quality) { p ->
                            dayProgress.isIndeterminate = false
                            dayProgress.progress = p
                            clip.status.text = "Сжатие: $p%"
                        }
                        // 2) загрузка
                        dayStatus.text = "$prefix: загружаю на сайт…"
                        val title = "Тренировка $titleDate, ${tf.format(Date(clip.takenMs))}"
                        upload(out, date, title) { p ->
                            dayProgress.isIndeterminate = false
                            dayProgress.progress = p
                            clip.status.text = "Загрузка: $p% из ${formatSize(out.length())}"
                        }
                        sentBytes += out.length()
                        clip.done = true
                        clip.check.isEnabled = false
                        clip.status.setTextColor(okColor)
                        clip.status.text = "✓ На сайте (${formatSize(clip.size)} → ${formatSize(out.length())})"
                        ok++
                    } catch (e: CancellationException) {
                        clip.status.text = "Остановлено"
                        throw e
                    } catch (e: Exception) {
                        clip.status.setTextColor(errColor)
                        clip.status.text = "Ошибка: ${e.message}"
                    } finally {
                        out.delete()
                    }
                }
                dayStatus.text = if (ok == queue.size) {
                    "Готово! Загружено $ok видео (${formatSize(sentBytes)}). Смотрите на сайте во вкладке «Видео»."
                } else {
                    "Загружено $ok из ${queue.size}. Нажмите кнопку ещё раз, чтобы повторить неудавшиеся."
                }
            } catch (e: CancellationException) {
                dayStatus.text = "Загрузка остановлена. Уже загруженные видео остались на сайте."
            } finally {
                setDayWorking(false)
                updateUploadButton()
            }
        }
    }

    private fun setDayWorking(working: Boolean) {
        keepScreenOn(working || singleJob?.isActive == true)
        dayProgress.visibility = if (working) View.VISIBLE else View.GONE
        dayProgress.isIndeterminate = true
        stopBtn.visibility = if (working) View.VISIBLE else View.GONE
        uploadBtn.isEnabled = !working
        dateBtn.isEnabled = !working
        pickBtn.isEnabled = !working
        if (working) dayStatus.visibility = View.VISIBLE
        clips.forEach { if (!it.done) it.check.isEnabled = !working }
        for (i in 0 until qualityGroup.childCount) qualityGroup.getChildAt(i).isEnabled = !working
    }

    // ================================================================ сжатие

    /** Сжимает видео в out. Работает на главном потоке (так требует Media3), ждёт окончания. */
    private suspend fun compress(uri: Uri, out: File, quality: Quality, onProgress: (Int) -> Unit) {
        val info = withContext(Dispatchers.IO) { readVideoInfo(uri) }
            ?: throw IllegalStateException("не удалось прочитать видео")

        val shortSide = min(info.displayWidth, info.displayHeight)
        val longSide = max(info.displayWidth, info.displayHeight)
        val targetShort = min(quality.shortSide, shortSide)
        val scale = targetShort.toDouble() / shortSide
        val isPortrait = info.displayHeight >= info.displayWidth
        var targetHeight = if (isPortrait) (longSide * scale).roundToInt() else targetShort
        targetHeight -= targetHeight % 2
        val bitrate = if (info.bitrate in 1 until quality.bitrate) info.bitrate else quality.bitrate

        out.delete()
        suspendCancellableCoroutine { cont ->
            val holder = ProgressHolder()
            lateinit var tick: Runnable
            val t = Transformer.Builder(this)
                .setVideoMimeType(MimeTypes.VIDEO_H264)
                .setAudioMimeType(MimeTypes.AUDIO_AAC)
                .setEncoderFactory(
                    DefaultEncoderFactory.Builder(this)
                        .setRequestedVideoEncoderSettings(VideoEncoderSettings.Builder().setBitrate(bitrate).build())
                        .setEnableFallback(true)
                        .build()
                )
                .addListener(object : Transformer.Listener {
                    override fun onCompleted(composition: Composition, exportResult: ExportResult) {
                        handler.removeCallbacks(tick)
                        if (cont.isActive) cont.resume(Unit)
                    }

                    override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
                        handler.removeCallbacks(tick)
                        if (cont.isActive) cont.resumeWithException(IllegalStateException("сжатие не удалось (${exportException.errorCodeName})"))
                    }
                })
                .build()
            tick = Runnable {
                if (t.getProgress(holder) == Transformer.PROGRESS_STATE_AVAILABLE) onProgress(holder.progress)
                handler.postDelayed(tick, 500)
            }
            cont.invokeOnCancellation {
                handler.post {
                    handler.removeCallbacks(tick)
                    t.cancel()
                }
            }
            val item = EditedMediaItem.Builder(MediaItem.fromUri(uri))
                // Не больше 30 кадр/с: видео в 60 кадр/с почти вдвое тяжелее, а для разбора трассы 30 хватает
                .setEffects(
                    Effects(
                        emptyList(),
                        listOf(FrameDropEffect.createDefaultFrameDropEffect(30f), Presentation.createForHeight(targetHeight)),
                    )
                )
                .build()
            t.start(item, out.absolutePath)
            handler.post(tick)
        }
    }

    // ================================================================ загрузка на сайт

    private fun authHeader(): String {
        val raw = "${prefs.getString("login", "")!!.trim()}:${prefs.getString("apppass", "")!!.replace(" ", "")}"
        return Base64.encodeToString(raw.toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
    }

    private fun site(): String = prefs.getString("site", DEFAULT_SITE)!!.trim().trimEnd('/')

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    /** Отправляет файл частями по 4 МБ. Каждую часть повторяет до 5 раз при сбое сети. */
    private suspend fun upload(file: File, date: String, title: String, onProgress: (Int) -> Unit) = withContext(Dispatchers.IO) {
        val chunk = 4 * 1024 * 1024
        val size = file.length()
        val total = max(1, ((size + chunk - 1) / chunk).toInt())
        val uploadId = UUID.randomUUID().toString().replace("-", "")
        val buf = ByteArray(chunk)
        RandomAccessFile(file, "r").use { raf ->
            var index = 0
            while (index < total) {
                raf.seek(index.toLong() * chunk)
                val len = raf.read(buf, 0, min(chunk.toLong(), size - index.toLong() * chunk).toInt())
                val url = "${site()}/?rest_route=/agility/v1/video/chunk" +
                    "&upload_id=$uploadId&index=$index&total=$total" +
                    "&date=${enc(date)}&name=${enc(file.name)}&title=${enc(title)}"
                var attempt = 0
                while (true) {
                    attempt++
                    val (code, body) = try {
                        post(url, buf, len)
                    } catch (e: Exception) {
                        if (attempt >= 5) throw IllegalStateException("нет связи с сайтом (${e.message})")
                        delay(2000L * attempt)
                        continue
                    }
                    if (code in 200..299) {
                        index++
                        break
                    }
                    val json = runCatching { JSONObject(body) }.getOrNull()
                    if (code == 409 && json != null) {
                        index = json.optJSONObject("data")?.optInt("next", index) ?: index
                        break
                    }
                    if (code == 401 || code == 403) throw IllegalStateException("сайт не принял вход — проверьте логин и пароль приложения")
                    if (code >= 500 && attempt < 5) {
                        delay(2000L * attempt)
                        continue
                    }
                    throw IllegalStateException(json?.optString("message")?.takeIf { it.isNotBlank() } ?: "ошибка сайта $code")
                }
                withContext(Dispatchers.Main) { onProgress((index * 100 / total)) }
            }
        }
    }

    private fun post(url: String, data: ByteArray, len: Int): Pair<Int, String> {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.requestMethod = "POST"
            c.doOutput = true
            c.connectTimeout = 20_000
            c.readTimeout = 120_000
            c.setFixedLengthStreamingMode(len)
            c.setRequestProperty("Content-Type", "application/octet-stream")
            c.setRequestProperty("Authorization", "Basic ${authHeader()}")
            c.setRequestProperty("X-Agility-Auth", authHeader())
            c.outputStream.use { it.write(data, 0, len) }
            val code = c.responseCode
            val body = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
            return code to body
        } finally {
            c.disconnect()
        }
    }

    private suspend fun checkLogin(): String = withContext(Dispatchers.IO) {
        val c = URL("${site()}/?rest_route=/agility/v1/me").openConnection() as HttpURLConnection
        try {
            c.connectTimeout = 15_000
            c.readTimeout = 20_000
            c.setRequestProperty("Authorization", "Basic ${authHeader()}")
            c.setRequestProperty("X-Agility-Auth", authHeader())
            val code = c.responseCode
            val body = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
            val j = runCatching { JSONObject(body) }.getOrNull()
            when {
                j == null -> "Сайт ответил непонятно (код $code). Проверьте адрес сайта."
                !j.optBoolean("logged_in") -> "Вход не принят: проверьте логин и пароль приложения."
                !j.optBoolean("can_upload") -> "Вход выполнен (${j.optString("name")}), но у пользователя нет прав администратора клуба."
                else -> "✓ Всё в порядке: ${j.optString("name")}, загрузка разрешена."
            }
        } catch (e: Exception) {
            "Нет связи с сайтом: ${e.message}"
        } finally {
            c.disconnect()
        }
    }

    private fun showSettings() {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(8), dp(20), 0)
        }
        fun field(hint: String, value: String, password: Boolean = false) = EditText(this).apply {
            this.hint = hint
            setText(value)
            inputType = if (password) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            else InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            isFocusableInTouchMode = true
            // Клавиатура открывается при каждом нажатии на поле — даже если окно открыто повторно
            setOnClickListener { showKeyboard(this) }
            setOnFocusChangeListener { v, has -> if (has) showKeyboard(v) }
            box.addView(this)
        }
        box.addView(TextView(this).apply {
            text = "Пароль приложения создаётся на сайте: Консоль → Пользователи → Профиль → «Пароли приложений»."
            textSize = 13f
            setTextColor(muted)
        })
        val siteF = field("Адрес сайта", prefs.getString("site", DEFAULT_SITE)!!)
        val loginF = field("Логин WordPress", prefs.getString("login", "")!!)
        val passF = field("Пароль приложения", prefs.getString("apppass", "")!!, password = true)
        val result = TextView(this).apply { textSize = 14f; setPadding(0, dp(8), 0, 0) }
        box.addView(result)

        val dlg = AlertDialog.Builder(this)
            .setTitle("Вход на сайт клуба")
            .setView(box)
            .setPositiveButton("Сохранить", null)
            .setNeutralButton("Проверить", null)
            .setNegativeButton("Закрыть", null)
            .create()
        fun save() = prefs.edit()
            .putString("site", siteF.text.toString().trim())
            .putString("login", loginF.text.toString().trim())
            .putString("apppass", passF.text.toString().trim())
            .apply()
        dlg.setOnShowListener {
            dlg.window?.clearFlags(
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM
            )
            dlg.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
            dlg.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener { save(); dlg.dismiss() }
            dlg.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener {
                save()
                result.setTextColor(muted)
                result.text = "Проверяю…"
                lifecycleScope.launch {
                    val msg = checkLogin()
                    result.setTextColor(if (msg.startsWith("✓")) okColor else errColor)
                    result.text = msg
                }
            }
        }
        dlg.show()
    }

    private fun showKeyboard(v: View) {
        v.requestFocus()
        v.post {
            val imm = getSystemService(INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager
            imm.showSoftInput(v, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
        }
    }

    // ================================================================ одно видео

    private fun startSingle(uri: Uri) {
        if (busy()) {
            Toast.makeText(this, "Дождитесь окончания текущей работы", Toast.LENGTH_SHORT).show()
            return
        }
        val quality = selectedQuality()
        prefs.edit().putInt("quality2", quality.ordinal).apply()
        val inputSize = querySize(uri)
        val dir = File(cacheDir, "compressed").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
        val out = File(dir, "agility_$stamp.mp4")
        outputFile = out

        singleJob = lifecycleScope.launch {
            setSingleWorking(true)
            status.text = "Сжимаю видео…"
            details.text = "Исходник: ${formatSize(inputSize)}"
            try {
                compress(uri, out, quality) { p ->
                    progress.isIndeterminate = false
                    progress.progress = p
                    status.text = "Сжимаю видео… $p%"
                }
                val size = out.length()
                val saved = if (inputSize > 0) 100 - (size * 100 / inputSize) else 0
                status.text = "Готово!"
                details.text = "Было ${formatSize(inputSize)} → стало ${formatSize(size)}" +
                    (if (saved > 0) " (меньше на $saved%)" else "") +
                    "\nНажмите «Отправить» и выберите ВКонтакте или Яндекс Диск."
                shareBtn.visibility = View.VISIBLE
                saveBtn.visibility = View.VISIBLE
            } catch (e: CancellationException) {
                out.delete()
                status.text = "Сжатие отменено"
                details.text = ""
            } catch (e: Exception) {
                out.delete()
                status.text = "Ошибка"
                details.text = "Не получилось: ${e.message}. Попробуйте качество 720p."
            } finally {
                setSingleWorking(false)
            }
        }
    }

    private fun setSingleWorking(working: Boolean) {
        keepScreenOn(working || dayJob?.isActive == true)
        progress.visibility = if (working) View.VISIBLE else View.GONE
        progress.isIndeterminate = true
        cancelBtn.visibility = if (working) View.VISIBLE else View.GONE
        pickBtn.isEnabled = !working
        dateBtn.isEnabled = !working
        if (::uploadBtn.isInitialized) uploadBtn.isEnabled = !working && clips.any { it.check.isChecked && !it.done }
        if (working) {
            shareBtn.visibility = View.GONE
            saveBtn.visibility = View.GONE
        }
        for (i in 0 until qualityGroup.childCount) qualityGroup.getChildAt(i).isEnabled = !working
    }

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
        if (Build.VERSION.SDK_INT < 29) {
            saveToGalleryLegacy(file)
            return
        }
        val values = ContentValues().apply {
            put(MediaStore.Video.Media.DISPLAY_NAME, file.name)
            put(MediaStore.Video.Media.MIME_TYPE, "video/mp4")
            put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/Аджилити")
            put(MediaStore.Video.Media.IS_PENDING, 1)
        }
        val collection = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val target = contentResolver.insert(collection, values)
        if (target == null) {
            Toast.makeText(this, "Не удалось сохранить в галерею", Toast.LENGTH_LONG).show()
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
            Toast.makeText(this, "Не удалось сохранить: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    /** Android 7–9: пишем в Movies/Аджилити напрямую (нужно разрешение на память). */
    private fun saveToGalleryLegacy(file: File) {
        if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            askWritePermission.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
            return
        }
        try {
            @Suppress("DEPRECATION")
            val dir = File(android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_MOVIES), "Аджилити")
            dir.mkdirs()
            val target = File(dir, file.name)
            file.copyTo(target, overwrite = true)
            android.media.MediaScannerConnection.scanFile(this, arrayOf(target.absolutePath), arrayOf("video/mp4"), null)
            Toast.makeText(this, "Сохранено в папку Movies/Аджилити", Toast.LENGTH_LONG).show()
        } catch (e: Exception) {
            Toast.makeText(this, "Не удалось сохранить: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    private val askWritePermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) outputFile?.takeIf { it.exists() }?.let { saveToGalleryLegacy(it) }
            else Toast.makeText(this, "Без разрешения на память сохранить нельзя — используйте «Отправить»", Toast.LENGTH_LONG).show()
        }

    // ================================================================ данные о видео

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
        return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, (s / 60) % 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
    }

    // ================================================================ интерфейс

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

    private fun label(text: String) = TextView(this).apply {
        this.text = text
        textSize = 13f
        setTextColor(muted)
        isAllCaps = true
        letterSpacing = 0.06f
        setPadding(0, dp(18), 0, 0)
    }

    private fun card(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(16), dp(14), dp(16), dp(16))
        background = GradientDrawable().apply {
            cornerRadius = dp(12).toFloat()
            setColor(Color.WHITE)
            setStroke(dp(1), Color.parseColor("#D9DFE9"))
        }
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            .apply { topMargin = dp(16) }
    }

    private fun title(text: String) = TextView(this).apply {
        this.text = text
        textSize = 18f
        setTypeface(typeface, Typeface.BOLD)
        setTextColor(ink)
    }

    private fun progressBar() = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
        max = 100
        visibility = View.GONE
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(12)).apply { topMargin = dp(12) }
    }

    private fun buildUi(): View {
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(ink)
            setPadding(dp(20), dp(28), dp(12), dp(20))
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
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
                    text = "Тренировки — на сайт клуба, в ВК и на Яндекс Диск"
                    textSize = 14f
                    setTextColor(Color.parseColor("#C9D2E3"))
                })
            })
            addView(TextView(context).apply {
                text = "⚙"
                textSize = 26f
                setTextColor(Color.WHITE)
                setPadding(dp(12), dp(8), dp(12), dp(8))
                contentDescription = "Вход на сайт"
                setOnClickListener { showSettings() }
            })
        }

        // Новая настройка (с версии 2.1): по умолчанию «экономно»
        val savedQ = prefs.getInt("quality2", Quality.ECO.ordinal)
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
            check((Quality.entries.getOrNull(savedQ) ?: Quality.ECO).ordinal + 1)
        }

        // --- тренировка → сайт
        dateBtn = button("", false) { chooseDate() }
        val findBtn = button("Найти видео за эту дату", true) { findVideosClicked() }
        dayInfo = TextView(this).apply { textSize = 14f; setTextColor(muted); setPadding(0, dp(12), 0, 0) }
        clipsBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        uploadBtn = button("Сжать и загрузить на сайт", true) { startDayUpload() }.apply { visibility = View.GONE }
        dayProgress = progressBar()
        dayStatus = TextView(this).apply {
            textSize = 15f
            setTextColor(ink)
            setTypeface(typeface, Typeface.BOLD)
            setPadding(0, dp(10), 0, 0)
            visibility = View.GONE
        }
        stopBtn = button("Остановить", false) { dayJob?.cancel() }.apply { visibility = View.GONE }
        val dayCard = card().apply {
            addView(title("Тренировка → на сайт"))
            addView(TextView(context).apply {
                text = "Все видео за день сжимаются и загружаются на вкладку «Видео» сайта. Держите приложение открытым до конца."
                textSize = 14f
                setTextColor(muted)
                setPadding(0, dp(4), 0, 0)
            })
            addView(dateBtn)
            addView(findBtn)
            addView(dayInfo)
            addView(clipsBox)
            addView(uploadBtn)
            addView(dayStatus)
            addView(dayProgress)
            addView(stopBtn)
        }

        // --- одно видео
        status = TextView(this).apply {
            text = "Выберите видео или отправьте его сюда из галереи через «Поделиться»."
            textSize = 15f
            setTextColor(ink)
            setTypeface(typeface, Typeface.BOLD)
            setPadding(0, dp(12), 0, 0)
        }
        details = TextView(this).apply { textSize = 14f; setTextColor(muted); setPadding(0, dp(6), 0, 0) }
        progress = progressBar()
        pickBtn = button("Выбрать видео", false) {
            pickVideo.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.VideoOnly))
        }
        cancelBtn = button("Отменить", false) { singleJob?.cancel() }.apply { visibility = View.GONE }
        shareBtn = button("Отправить (ВК, Яндекс Диск…)", true) { shareResult() }.apply { visibility = View.GONE }
        saveBtn = button("Сохранить в галерею", false) { saveToGallery() }.apply { visibility = View.GONE }
        val singleCard = card().apply {
            addView(title("Одно видео → ВК / Яндекс Диск"))
            addView(pickBtn)
            addView(status)
            addView(details)
            addView(progress)
            addView(cancelBtn)
            addView(shareBtn)
            addView(saveBtn)
        }

        val body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), 0, dp(16), dp(32))
            addView(label("Качество"))
            addView(qualityGroup)
            addView(dayCard)
            addView(singleCard)
        }

        return ScrollView(this).apply {
            setBackgroundColor(Color.parseColor("#F3F5F8"))
            addView(LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                addView(header)
                addView(body)
            })
        }
    }

    companion object {
        const val DEFAULT_SITE = "https://cr461487.tw1.ru"
    }
}
