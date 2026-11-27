package com.motionorganizer

import android.app.AlertDialog
import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.util.Log
import android.util.Size
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import android.widget.VideoView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.FallbackStrategy
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.lifecycle.lifecycleScope
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.label.ImageLabel
import com.google.mlkit.vision.label.ImageLabeler
import com.google.mlkit.vision.label.ImageLabeling
import com.google.mlkit.vision.label.defaults.ImageLabelerOptions
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.io.File
import java.io.ByteArrayOutputStream
import kotlin.math.abs
import java.util.UUID

private const val TAG = "MotionOrganizer"
private const val PREFS_NAME = "motion_organizer"
private const val RESULTS_KEY = "results"
private const val MAX_RESULTS = 100

private data class AnalysisResult(
    val title: String,
    val category: String,
    val timestamp: Long,
    val uri: String?,
    val motionSamples: Int,
    val report: String = "",
    val backupId: String? = null,
)

@ExperimentalGetImage
class MainActivity : androidx.activity.ComponentActivity() {
    private lateinit var root: LinearLayout
    private lateinit var imageLabeler: ImageLabeler
    private lateinit var cameraExecutor: ExecutorService
    private var analysisProgressView: TextView? = null
    private var liveStatus: TextView? = null
    private var cameraProvider: ProcessCameraProvider? = null
    private var videoCapture: VideoCapture<Recorder>? = null
    private var activeRecording: Recording? = null
    private val recordingHandler = Handler(Looper.getMainLooper())
    private var recordingStopRunnable: Runnable? = null
    private var recordingStartedAt = 0L
    @Volatile
    private var lastLiveMotionAt = 0L
    private var liveBaseline: IntArray? = null
    private var lastLiveLabelTime = 0L
    private var lastLiveEventTime = 0L
    @Volatile
    private var isShowingLiveMonitor = false
    private var isAnalyzingVideo = false
    private var isUpdatingAlertsToggle = false
    private var isUpdatingRecordingToggle = false
    private var motionNotificationsEnabled = false
    private var motionAlertsToggle: CheckBox? = null
    private var eventRecordingEnabled = false

    private val videoPicker = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) analyzeVideos(uris)
    }

    private val exportBackupPicker = registerForActivityResult(
        ActivityResultContracts.CreateDocument("application/json"),
    ) { uri ->
        if (uri != null) exportReports(uri)
    }

    private val importBackupPicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) importReports(uri)
    }

    private fun startEventRecording(category: String, timestamp: Long) {
        if (!eventRecordingEnabled || activeRecording != null || !isShowingLiveMonitor) return
        val capture = videoCapture ?: return
        val directory = File(filesDir, RECORDINGS_DIRECTORY)
        if (!directory.exists() && !directory.mkdirs()) {
            Log.e(TAG, "Could not create the local recordings directory.")
            saveResult(AnalysisResult(
                "Live camera event",
                category,
                timestamp,
                null,
                1,
                "Movement detected, but the app couldn't create a folder for the video clip.",
            ))
            showToast("Couldn't create a folder for the motion clip.")
            return
        }
        val file = File(directory, "motion-${timestamp}.mp4")
        try {
            val options = FileOutputOptions.Builder(file).build()
            activeRecording = capture.output.prepareRecording(this, options)
                .start(ContextCompat.getMainExecutor(this)) { event ->
                    if (event is VideoRecordEvent.Finalize) {
                        activeRecording = null
                        recordingStopRunnable?.let(recordingHandler::removeCallbacks)
                        recordingStopRunnable = null
                        if (event.hasError()) {
                            Log.e(TAG, "Motion clip recording failed with code ${event.error}.")
                            file.delete()
                            saveResult(AnalysisResult(
                                "Live camera event",
                                category,
                                timestamp,
                                null,
                                1,
                                "Movement was detected, but video recording failed. No clip was saved.",
                            ))
                            showToast("Motion was detected, but the clip couldn't be saved.")
                        } else {
                            val durationSeconds = event.recordingStats.recordedDurationNanos / 1_000_000_000L
                            val result = AnalysisResult(
                                "Motion clip · ${file.nameWithoutExtension}",
                                category,
                                timestamp,
                                Uri.fromFile(file).toString(),
                                1,
                                "Recorded on this device for ${durationSeconds} seconds. Recording starts after motion is detected and stops after 5 seconds of quiet or 60 seconds.",
                            )
                            if (saveResult(result)) {
                                pruneOldRecordings()
                                liveStatus?.text = "Motion clip saved · $category"
                            } else {
                                file.delete()
                                showToast("The motion clip was recorded but its report couldn't be saved.")
                            }
                        }
                    }
                }
            recordingStartedAt = timestamp
            scheduleEventRecordingStop()
        } catch (error: Exception) {
            activeRecording = null
            Log.e(TAG, "Could not start motion clip recording.", error)
            file.delete()
            showToast("Motion was detected, but video recording couldn't start.")
        }
    }

    private fun scheduleEventRecordingStop() {
        recordingStopRunnable?.let(recordingHandler::removeCallbacks)
        val stopCheck = object : Runnable {
            override fun run() {
                val now = System.currentTimeMillis()
                if (!isShowingLiveMonitor || now - lastLiveMotionAt >= RECORDING_QUIET_MS ||
                    now - recordingStartedAt >= MAX_EVENT_RECORDING_MS
                ) {
                    stopEventRecording()
                } else {
                    recordingHandler.postDelayed(this, RECORDING_STOP_CHECK_MS)
                }
            }
        }
        recordingStopRunnable = stopCheck
        recordingHandler.postDelayed(stopCheck, RECORDING_STOP_CHECK_MS)
    }

    private fun stopEventRecording() {
        recordingStopRunnable?.let(recordingHandler::removeCallbacks)
        recordingStopRunnable = null
        activeRecording?.stop()
    }

    private fun pruneOldRecordings() {
        val directory = File(filesDir, RECORDINGS_DIRECTORY)
        val recordings = directory.listFiles()?.filter { it.isFile }?.sortedByDescending { it.lastModified() }
            ?: return
        var keptCount = 0
        var keptBytes = 0L
        recordings.forEach { oldFile ->
            if (keptCount < MAX_SAVED_RECORDINGS && keptBytes + oldFile.length() <= MAX_RECORDING_BYTES) {
                keptCount++
                keptBytes += oldFile.length()
                return@forEach
            }
            val oldUri = Uri.fromFile(oldFile).toString()
            if (!oldFile.delete()) {
                Log.e(TAG, "Could not remove an old motion clip: ${oldFile.name}")
                return@forEach
            }
            val results = loadResults().map { result ->
                if (result.uri == oldUri) result.copy(uri = null, report = "${result.report} The clip was removed to limit local storage.")
                else result
            }
            if (!persistResults(results)) Log.e(TAG, "Could not update a report after removing an old clip.")
        }
    }

    private val cameraPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            showLiveCamera()
        } else {
            showToast("Allow camera access to monitor movement.")
        }
    }

    private val notificationsPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            updateMotionNotificationsEnabled(true)
        } else {
            updateMotionNotificationsEnabled(false)
            showToast("Motion notifications are off. You can turn them on in Android settings.")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, true)
        window.statusBarColor = Color.rgb(246, 247, 251)
        window.navigationBarColor = Color.rgb(246, 247, 251)
        window.decorView.systemUiVisibility =
            View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        imageLabeler = ImageLabeling.getClient(ImageLabelerOptions.DEFAULT_OPTIONS)
        cameraExecutor = Executors.newSingleThreadExecutor()
        motionNotificationsEnabled = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getBoolean(MOTION_NOTIFICATIONS_KEY, false)
        eventRecordingEnabled = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getBoolean(EVENT_RECORDING_KEY, false)
        createMotionNotificationChannel()
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(color(R.color.background))
        }
        setContentView(root)
        showDashboard()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (isShowingLiveMonitor) {
                    stopLiveCamera()
                    showDashboard()
                } else {
                    finish()
                }
            }
        })
    }

    override fun onDestroy() {
        stopLiveCamera()
        cameraExecutor.shutdown()
        imageLabeler.close()
        super.onDestroy()
    }

    override fun onStop() {
        if (isShowingLiveMonitor) {
            stopLiveCamera()
            showDashboard()
        }
        super.onStop()
    }

    private fun showDashboard(progressMessage: String? = null) {
        isShowingLiveMonitor = false
        liveStatus = null
        analysisProgressView = null
        root.removeAllViews()
        val scrollView = ScrollView(this)
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(28), dp(24), dp(28))
        }
        scrollView.addView(content)
        root.addView(scrollView, LinearLayout.LayoutParams(-1, -1))

        content.addView(text("MOTION ORGANIZER", 12, color(R.color.primary), true))
        content.addView(text("Motion, made simple.", 28, color(R.color.text_primary), true).apply {
            setPadding(0, dp(8), 0, dp(6))
        })
        content.addView(text(
            "Choose a video to analyze, or check your camera while the app is open. Results stay here unless you export a report backup.",
            15,
            color(R.color.text_secondary),
        ).apply {
            setPadding(0, 0, 0, dp(20))
        })

        val results = loadResults()
        val people = results.count { it.category == "People" }
        val pets = results.count { it.category == "Pets" }
        val other = results.count { it.category == "Other motion" }
        content.addView(card().apply {
            addView(text("RECENT ACTIVITY", 12, color(R.color.text_secondary), true))
            addView(text("$people people   ·   $pets pets   ·   $other other", 18, color(R.color.text_primary), true).apply {
                setPadding(0, dp(8), 0, 0)
            })
        })

        content.addView(button("Choose videos to analyze") {
            if (!isAnalyzingVideo) videoPicker.launch(arrayOf("video/*"))
        }, topMargin(16))
        content.addView(button("Monitor camera while app is open", secondary = true) {
            requestCameraPermission()
        }, topMargin(10))
        val alertsToggle = CheckBox(this).apply {
            text = "Send local motion notifications"
            isChecked = motionNotificationsEnabled
            setOnCheckedChangeListener { _, enabled ->
                if (isUpdatingAlertsToggle) return@setOnCheckedChangeListener
                if (enabled && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                    ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                ) {
                    updateMotionNotificationsEnabled(false)
                    notificationsPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                } else {
                    updateMotionNotificationsEnabled(enabled)
                }
            }
        }
        motionAlertsToggle = alertsToggle
        content.addView(alertsToggle, topMargin(8))
        val recordingToggle = CheckBox(this).apply {
            text = "Save short local clips when motion is detected"
            isChecked = eventRecordingEnabled
            setOnCheckedChangeListener { _, enabled ->
                if (isUpdatingRecordingToggle) return@setOnCheckedChangeListener
                val saved = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .edit()
                    .putBoolean(EVENT_RECORDING_KEY, enabled)
                    .commit()
                if (!saved) {
                    Log.e(TAG, "Could not save the event recording setting.")
                    showToast("Couldn't save the recording setting. Try again.")
                    isUpdatingRecordingToggle = true
                    isChecked = eventRecordingEnabled
                    isUpdatingRecordingToggle = false
                    return@setOnCheckedChangeListener
                }
                eventRecordingEnabled = enabled
                if (!enabled) stopEventRecording()
            }
        }
        content.addView(recordingToggle, topMargin(4))
        content.addView(text(
            "Move reports between devices",
            12,
            color(R.color.text_secondary),
            true,
        ).apply {
            setPadding(0, dp(22), 0, dp(4))
        })
        content.addView(text(
            "Export reports to a cloud drive you choose, then import them on another device. Backups include titles, labels, and timestamps; clips remain on this device.",
            13,
            color(R.color.text_secondary),
        ))
        content.addView(button("Export report backup") {
            exportBackupPicker.launch("motion-organizer-reports.json")
        }, topMargin(8))
        content.addView(button("Import report backup", secondary = true) {
            importBackupPicker.launch(arrayOf("application/json", "text/json"))
        }, topMargin(4))

        if (progressMessage != null) {
            val progress = card()
            progress.addView(ProgressBar(this).apply { isIndeterminate = true })
            val progressText = text(progressMessage, 14, color(R.color.text_secondary)).apply {
                setPadding(0, dp(8), 0, 0)
            }
            analysisProgressView = progressText
            progress.addView(progressText)
            content.addView(progress, topMargin(16))
        }

        content.addView(text("RECENT RESULTS", 12, color(R.color.text_secondary), true).apply {
            setPadding(0, dp(28), 0, dp(10))
        })
        if (results.isEmpty()) {
            content.addView(card().apply {
                addView(text("No activity yet", 17, color(R.color.text_primary), true))
                addView(text("Analyze a video or monitor your camera to see results here.", 14, color(R.color.text_secondary)).apply {
                    setPadding(0, dp(6), 0, 0)
                })
            })
        } else {
            results.forEach { result ->
                val item = card().apply {
                    addView(text(result.category.uppercase(), 11, color(R.color.primary), true))
                    addView(text(result.title, 16, color(R.color.text_primary), true).apply {
                        setPadding(0, dp(5), 0, dp(3))
                    })
                    addView(text(
                        "${formatDate(result.timestamp)}  ·  ${result.motionSamples} motion samples",
                        13,
                        color(R.color.text_secondary),
                    ))
                    if (result.report.isNotBlank()) {
                        addView(text(result.report, 14, color(R.color.text_secondary)).apply {
                            setPadding(0, dp(8), 0, 0)
                        })
                    }
                    if (result.uri != null) {
                        setOnClickListener { openVideo(result.uri) }
                    }
                }

                content.addView(item, topMargin(8))
            }
        }
    }

    private fun requestCameraPermission() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            showLiveCamera()
        } else {
            cameraPermission.launch(Manifest.permission.CAMERA)
        }
    }

    @ExperimentalGetImage
    private fun showLiveCamera() {
        isShowingLiveMonitor = true
        liveBaseline = null
        lastLiveLabelTime = 0L
        lastLiveEventTime = 0L
        root.removeAllViews()

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(18), dp(20), dp(14))
            addView(text("CAMERA MONITOR", 12, color(R.color.primary), true))
            addView(text("Monitoring while this screen is open", 22, color(R.color.text_primary), true).apply {
                setPadding(0, dp(6), 0, dp(4))
            })
            liveStatus = text(
                "Monitoring stops when you leave this screen. Motion alerts are saved on this device.",
                14,
                color(R.color.text_secondary),
            ).also { addView(it) }
        }
        root.addView(header)

        val preview = PreviewView(this).apply {
            scaleType = PreviewView.ScaleType.FILL_CENTER
        }
        root.addView(preview, LinearLayout.LayoutParams(-1, 0, 1f))
        root.addView(button("Stop camera monitor", secondary = true) {
            stopLiveCamera()
            showDashboard()
        }, LinearLayout.LayoutParams(-1, -2).apply {
            setMargins(dp(20), dp(12), dp(20), dp(20))
        })

        val providerFuture = ProcessCameraProvider.getInstance(this)
        providerFuture.addListener({
            if (!isShowingLiveMonitor || isFinishing || isDestroyed) return@addListener
            try {
                val provider = providerFuture.get()
                val previewUseCase = Preview.Builder().build().also {
                    it.setSurfaceProvider(preview.surfaceProvider)
                }
                val analysis = ImageAnalysis.Builder()
                    .setTargetResolution(Size(640, 480))
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                val recorder = Recorder.Builder()
                    .setQualitySelector(QualitySelector.from(Quality.SD, FallbackStrategy.lowerQualityOrHigherThan(Quality.SD)))
                    .build()
                val capture = VideoCapture.withOutput(recorder)
                analysis.setAnalyzer(cameraExecutor, ::analyzeCameraFrame)
                provider.unbindAll()
                cameraProvider = provider
                try {
                    if (eventRecordingEnabled) {
                        provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, previewUseCase, analysis, capture)
                        videoCapture = capture
                    } else {
                        provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, previewUseCase, analysis)
                        videoCapture = null
                    }
                } catch (recordingError: Exception) {
                    if (!eventRecordingEnabled) throw recordingError
                    Log.w(TAG, "This camera cannot record and analyze video together; continuing without clip recording.", recordingError)
                    provider.unbindAll()
                    provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, previewUseCase, analysis)
                    videoCapture = null
                    showToast("Camera monitoring is on, but this camera can't save clips while detecting motion.")
                }
            } catch (error: Exception) {
                Log.e(TAG, "Could not start the in-app camera monitor.", error)
                stopLiveCamera()
                showDashboard()
                showToast("Could not start the camera: ${error.localizedMessage ?: "unknown error"}")
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun stopLiveCamera() {
        isShowingLiveMonitor = false
        recordingStopRunnable?.let(recordingHandler::removeCallbacks)
        recordingStopRunnable = null
        stopEventRecording()
        cameraProvider?.unbindAll()
        cameraProvider = null
        videoCapture = null
        liveStatus = null
        liveBaseline = null
    }

    @ExperimentalGetImage
    private fun analyzeCameraFrame(proxy: ImageProxy) {
        var processingStarted = false
        try {
            val mediaImage = proxy.image ?: return
            val current = sampleLuma(
                mediaImage.planes[0].buffer,
                mediaImage.planes[0].rowStride,
                mediaImage.planes[0].pixelStride,
                proxy.cropRect,
            )
            val previous = liveBaseline
            liveBaseline = current
            val now = System.currentTimeMillis()
            val motionDetected = previous != null && isMotion(previous, current)
            if (isShowingLiveMonitor && motionDetected) {
                lastLiveMotionAt = now
                recordingHandler.post { scheduleEventRecordingStop() }
            }
            if (!isShowingLiveMonitor || !motionDetected ||
                now - lastLiveLabelTime < LABEL_INTERVAL_MS
            ) {
                return
            }
            lastLiveLabelTime = now
            runOnUiThread { liveStatus?.text = "Motion detected · checking activity…" }
            val input = InputImage.fromMediaImage(mediaImage, proxy.imageInfo.rotationDegrees)
            imageLabeler.process(input)
                .addOnSuccessListener(cameraExecutor) { labels ->
                    if (!isShowingLiveMonitor) return@addOnSuccessListener
                    val category = categoryFor(labels) ?: "Other motion"
                    if (now - lastLiveEventTime < LIVE_EVENT_COOLDOWN_MS) return@addOnSuccessListener
                    lastLiveEventTime = now
                    runOnUiThread {
                        if (!isShowingLiveMonitor) return@runOnUiThread
                    if (eventRecordingEnabled && videoCapture != null) {
                        startEventRecording(category, now)
                        liveStatus?.text = "Motion detected · recording a short clip"
                    } else {
                        val result = AnalysisResult(
                            "Live camera event",
                            category,
                            now,
                            null,
                            1,
                            "Movement was detected in the live camera view. No video clip was saved.",
                        )
                        liveStatus?.text = if (saveResult(result)) "Motion saved · $category"
                        else "Motion detected · couldn't save event"
                    }
                    sendMotionNotification(category, now)
                    }
                }
                .addOnFailureListener(cameraExecutor) { error ->
                    Log.e(TAG, "Could not label a camera motion event.", error)
                    runOnUiThread { liveStatus?.text = "Motion detected · activity labels unavailable" }
                }
                .addOnCompleteListener(cameraExecutor) { proxy.close() }
            processingStarted = true
        } catch (error: Exception) {
            Log.e(TAG, "Could not analyze an in-app camera frame.", error)
        } finally {
            if (!processingStarted) proxy.close()
        }
    }

    private fun sampleLuma(
        buffer: java.nio.ByteBuffer,
        rowStride: Int,
        pixelStride: Int,
        crop: Rect,
    ): IntArray {
        val plane = buffer.duplicate()
        val width = crop.width()
        val height = crop.height()
        return IntArray(SAMPLE_WIDTH * SAMPLE_HEIGHT) { index ->
            val sampleX = index % SAMPLE_WIDTH
            val sampleY = index / SAMPLE_WIDTH
            val x = crop.left + sampleX * width / SAMPLE_WIDTH
            val y = crop.top + sampleY * height / SAMPLE_HEIGHT
            plane.get(y * rowStride + x * pixelStride).toInt() and 0xFF
        }
    }

    private fun createMotionNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = android.app.NotificationChannel(
                MOTION_CHANNEL_ID,
                "Motion alerts",
                android.app.NotificationManager.IMPORTANCE_DEFAULT,
            )
            getSystemService(android.app.NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun sendMotionNotification(category: String, timestamp: Long) {
        if (!motionNotificationsEnabled) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        try {
            val notification = NotificationCompat.Builder(this, MOTION_CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_menu_camera)
                .setContentTitle("Movement detected")
                .setContentText(category)
                .setAutoCancel(true)
                .build()
            NotificationManagerCompat.from(this).notify(
                (timestamp % Int.MAX_VALUE).toInt().coerceAtLeast(1),
                notification,
            )
        } catch (error: SecurityException) {
            Log.e(TAG, "Could not show a motion notification.", error)
        }
    }

    private fun updateMotionNotificationsEnabled(enabled: Boolean) {
        val saved = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(MOTION_NOTIFICATIONS_KEY, enabled)
            .commit()
        if (!saved) {
            Log.e(TAG, "Could not save the motion notification setting.")
            showToast("Couldn't save the notification setting. Try again.")
            updateAlertsToggle(motionNotificationsEnabled)
            return
        }
        motionNotificationsEnabled = enabled
        updateAlertsToggle(enabled)
    }

    private fun updateAlertsToggle(enabled: Boolean) {
        isUpdatingAlertsToggle = true
        motionAlertsToggle?.isChecked = enabled
        isUpdatingAlertsToggle = false
    }

    private fun analyzeVideos(uris: List<Uri>) {
        if (isAnalyzingVideo || uris.isEmpty()) return
        isAnalyzingVideo = true
        var completed = 0
        val failures = mutableListOf<String>()
        showDashboard("Analyzing 0 of ${uris.size} videos…")
        lifecycleScope.launch {
            try {
                for ((index, uri) in uris.withIndex()) {
                    try {
                        try {
                            contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        } catch (error: SecurityException) {
                            Log.w(TAG, "Video access could not be retained after this session.", error)
                        }
                        val result = analyzeVideoFrames(uri)
                        if (!saveResult(result)) {
                            throw IllegalStateException("Could not save the result on this device.")
                        }
                        completed++
                    } catch (error: Exception) {
                        if (error is CancellationException) throw error
                        Log.e(TAG, "Video analysis failed for ${queryVideoName(uri)}.", error)
                        failures.add("${queryVideoName(uri)}: ${error.localizedMessage ?: "unknown error"}")
                    }
                    analysisProgressView?.text = "Analyzed ${index + 1} of ${uris.size} videos…"
                }
            } finally {
                isAnalyzingVideo = false
                if (!isFinishing && !isDestroyed) {
                    showDashboard()
                    if (failures.isEmpty()) {
                        showToast("Analyzed $completed ${if (completed == 1) "video" else "videos"}.")
                    } else {
                        showToast("Analyzed $completed of ${uris.size}; ${failures.size} failed. ${failures.first()}")
                    }
                }
            }
        }
    }

    private suspend fun analyzeVideoFrames(uri: Uri): AnalysisResult = withContext(Dispatchers.IO) {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(this@MainActivity, uri)
            val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                ?.toLongOrNull() ?: 0L
            if (durationMs <= 0L) {
                throw IllegalArgumentException("The selected video has no readable duration.")
            }

            val title = queryVideoName(uri)
            var previous: IntArray? = null
            var motionSamples = 0
            var peopleLabels = 0
            var petLabels = 0
            val motionSeconds = mutableListOf<Long>()
            var second = 0L

            while (second * 1_000L < durationMs) {
                val bitmap = retriever.getFrameAtTime(
                    second * 1_000_000L,
                    MediaMetadataRetriever.OPTION_CLOSEST,
                )
                if (bitmap != null) {
                    try {
                        val current = sampleBitmapLuma(bitmap)
                        val before = previous
                        previous = current
                        if (before != null && isMotion(before, current)) {
                            motionSamples++
                            motionSeconds.add(second)
                            val labels = imageLabeler.process(InputImage.fromBitmap(bitmap, 0)).await()
                            when (categoryFor(labels)) {
                                "People" -> peopleLabels++
                                "Pets" -> petLabels++
                            }
                        }
                    } finally {
                        bitmap.recycle()
                    }
                }
                second++
                if (second % 10L == 0L) {
                    withContext(Dispatchers.Main) {
                        analysisProgressView?.text = "Analyzed $second seconds…"
                    }
                }
            }

            val category = when {
                motionSamples == 0 -> "No motion"
                peopleLabels > petLabels && peopleLabels > 0 -> "People"
                petLabels > 0 -> "Pets"
                else -> "Other motion"
            }
            AnalysisResult(
                title,
                category,
                System.currentTimeMillis(),
                uri.toString(),
                motionSamples,
                buildVideoReport(durationMs / 1_000L, motionSeconds),
            )
        } finally {
            retriever.release()
        }
    }

    private fun sampleBitmapLuma(bitmap: Bitmap): IntArray {
        val sample = Bitmap.createScaledBitmap(bitmap, SAMPLE_WIDTH, SAMPLE_HEIGHT, true)
        val pixels = IntArray(SAMPLE_WIDTH * SAMPLE_HEIGHT)
        sample.getPixels(pixels, 0, SAMPLE_WIDTH, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT)
        if (sample !== bitmap) sample.recycle()
        return IntArray(pixels.size) { index ->
            val pixel = pixels[index]
            (Color.red(pixel) * 299 + Color.green(pixel) * 587 + Color.blue(pixel) * 114) / 1_000
        }
    }

    private fun isMotion(previous: IntArray, current: IntArray): Boolean {
        if (previous.size != current.size || current.isEmpty()) return false
        var changed = 0
        var totalDifference = 0
        for (index in current.indices) {
            val difference = abs(current[index] - previous[index])
            totalDifference += difference
            if (difference >= PIXEL_CHANGE_THRESHOLD) changed++
        }
        return changed.toFloat() / current.size >= CHANGED_PIXEL_RATIO &&
            totalDifference.toFloat() / current.size >= AVERAGE_CHANGE_THRESHOLD
    }

    private fun categoryFor(labels: List<ImageLabel>): String? {
        val confidentLabels = labels.filter { it.confidence >= LABEL_CONFIDENCE }
        return when {
            confidentLabels.any { it.text.contains("person", ignoreCase = true) } -> "People"
            confidentLabels.any {
                it.text.contains("dog", ignoreCase = true) ||
                    it.text.contains("cat", ignoreCase = true) ||
                    it.text.contains("pet", ignoreCase = true) ||
                    it.text.contains("animal", ignoreCase = true)
            } -> "Pets"
            else -> null
        }
    }

    private fun buildVideoReport(durationSeconds: Long, motionSeconds: List<Long>): String {
        if (motionSeconds.isEmpty()) return "No motion was detected in ${formatDuration(durationSeconds)} of video."
        var periods = 1
        for (index in 1 until motionSeconds.size) {
            if (motionSeconds[index] - motionSeconds[index - 1] > 2L) periods++
        }
        return "Detected ${motionSeconds.size} motion samples across $periods activity ${if (periods == 1) "period" else "periods"} in ${formatDuration(durationSeconds)} of video. This is an automated motion summary, not an identification."
    }

    private fun formatDuration(seconds: Long): String {
        val minutes = seconds / 60
        val remainder = seconds % 60
        return if (minutes > 0) "${minutes}m ${remainder}s" else "${remainder}s"
    }

    private fun queryVideoName(uri: Uri): String {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (column >= 0) return cursor.getString(column)
            }
        }
        return uri.lastPathSegment?.substringAfterLast('/') ?: "Selected video"
    }

    private fun loadResults(): List<AnalysisResult> {
        val raw = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getString(RESULTS_KEY, "[]") ?: "[]"
        return try {
            val array = JSONArray(raw)
            List(array.length()) { index ->
                val item = array.getJSONObject(index)
                AnalysisResult(
                    title = item.getString("title"),
                    category = item.getString("category"),
                    timestamp = item.getLong("timestamp"),
                    uri = if (item.isNull("uri")) null else item.getString("uri"),
                    motionSamples = item.getInt("motionSamples"),
                    report = item.optString("report"),
                    backupId = if (item.isNull("backupId")) null else item.optString("backupId").takeIf(String::isNotBlank),
                )
            }
        } catch (error: JSONException) {
            Log.e(TAG, "Saved activity results are unreadable.", error)
            showToast("Saved results could not be loaded.")
            emptyList()
        }
    }

    private fun saveResult(result: AnalysisResult): Boolean {
        val identified = if (result.backupId.isNullOrBlank()) result.copy(backupId = UUID.randomUUID().toString()) else result
        val results = (listOf(identified) + loadResults()).take(MAX_RESULTS)
        return persistResults(results)
    }

    private fun persistResults(results: List<AnalysisResult>): Boolean {
        val array = JSONArray()
        results.forEach { item ->
            array.put(JSONObject().apply {
                put("title", item.title)
                put("category", item.category)
                put("timestamp", item.timestamp)
                put("uri", item.uri)
                put("motionSamples", item.motionSamples)
                put("report", item.report)
                put("backupId", item.backupId)
            })
        }
        val saved = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(RESULTS_KEY, array.toString())
            .commit()
        if (!saved) {
            Log.e(TAG, "Could not save an activity result.")
            return false
        }
        return true
    }

    private fun exportReports(uri: Uri) {
        val current = loadResults()
        val identified = current.map { result ->
            if (result.backupId.isNullOrBlank()) result.copy(backupId = UUID.randomUUID().toString()) else result
        }
        if (identified != current && !persistResults(identified)) {
            showToast("Couldn't prepare saved reports for export.")
            return
        }
        val events = JSONArray()
        identified.forEach { result ->
            events.put(JSONObject().apply {
                put("backupId", result.backupId)
                put("title", result.title)
                put("category", result.category)
                put("timestamp", result.timestamp)
                put("samples", result.motionSamples)
                put("report", result.report)
            })
        }
        val payload = JSONObject()
            .put("format", BACKUP_FORMAT)
            .put("version", BACKUP_VERSION)
            .put("createdAt", System.currentTimeMillis())
            .put("events", events)
            .toString(2)
        lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    contentResolver.openOutputStream(uri, "wt")?.use { output ->
                        output.write(payload.toByteArray(Charsets.UTF_8))
                    } ?: throw IllegalStateException("The selected backup location could not be opened.")
                }
                showToast("Report backup exported. Video clips remain on this device.")
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                Log.e(TAG, "Could not export a report backup.", error)
                showToast("Couldn't export reports: ${error.localizedMessage ?: "unknown error"}")
            }
        }
    }

    private fun importReports(uri: Uri) {
        lifecycleScope.launch {
            try {
                val backup = withContext(Dispatchers.IO) {
                    val content = ByteArrayOutputStream()
                    contentResolver.openInputStream(uri)?.use { input ->
                        val buffer = ByteArray(8_192)
                        while (true) {
                            val count = input.read(buffer)
                            if (count < 0) break
                            if (content.size() + count > MAX_BACKUP_BYTES) {
                                throw IllegalArgumentException("The report backup is larger than 2 MB.")
                            }
                            content.write(buffer, 0, count)
                        }
                    } ?: throw IllegalStateException("The selected backup file could not be opened.")
                    JSONObject(content.toString(Charsets.UTF_8.name()))
                }
                val events = backup.optJSONArray("events")
                if (backup.optString("format") != BACKUP_FORMAT ||
                    backup.optInt("version", -1) != BACKUP_VERSION ||
                    events == null || events.length() > MAX_BACKUP_EVENTS
                ) {
                    throw IllegalArgumentException("This file isn't a supported Motion Organizer report backup.")
                }

                val existing = loadResults().map { result ->
                    if (result.backupId.isNullOrBlank()) result.copy(backupId = UUID.randomUUID().toString()) else result
                }
                val knownIds = existing.mapNotNull { it.backupId }.toMutableSet()
                val imported = mutableListOf<AnalysisResult>()
                val importedIds = mutableSetOf<String>()
                for (index in 0 until events.length()) {
                    val event = events.optJSONObject(index) ?: continue
                    val title = event.optString("title")
                    val category = event.optString("category")
                    val backupId = event.optString("backupId")
                    val timestamp = event.optLong("timestamp", 0L)
                    val samples = event.optInt("samples", event.optInt("motionSamples", -1))
                    if (title.isBlank() || title.length > 256 || category.isBlank() || category.length > 64 ||
                        backupId.isBlank() || backupId.length > 200 || timestamp <= 0L ||
                        samples < 0 || samples > MAX_BACKUP_SAMPLES || !knownIds.add(backupId)
                    ) continue
                    imported.add(AnalysisResult(
                        title = title,
                        category = category,
                        timestamp = timestamp,
                        uri = null,
                        motionSamples = samples,
                        report = event.optString("report").take(2_000),
                        backupId = backupId,
                    ))
                    importedIds.add(backupId)
                }
                val merged = (imported + existing)
                    .distinctBy { it.backupId }
                    .sortedByDescending { it.timestamp }
                    .take(MAX_RESULTS)
                if (!persistResults(merged)) {
                    throw IllegalStateException("The imported reports couldn't be saved on this device.")
                }
                val retainedCount = merged.count { it.backupId in importedIds }
                showDashboard()
                showToast(if (retainedCount == 0) {
                    "No new reports were found in that backup."
                } else {
                    "Imported $retainedCount report${if (retainedCount == 1) "" else "s"}. Video clips aren't included." +
                        if (retainedCount < importedIds.size) " Older reports weren't kept because history is limited to $MAX_RESULTS." else ""
                })
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                Log.e(TAG, "Could not import a report backup.", error)
                showToast("Couldn't import reports: ${error.localizedMessage ?: "unknown error"}")
            }
        }
    }

    private fun openVideo(value: String) {
        try {
            val player = VideoView(this).apply {
                setVideoURI(Uri.parse(value))
                setOnPreparedListener { it.start() }
                layoutParams = LinearLayout.LayoutParams(-1, dp(220))
                setOnErrorListener { _, what, extra ->
                    Log.e(TAG, "Could not play a saved video. Error $what/$extra.")
                    showToast("This video couldn't be played on this device.")
                    true
                }
            }
            AlertDialog.Builder(this)
                .setTitle("Motion Organizer recording")
                .setView(player)
                .setPositiveButton("Close") { dialog, _ ->
                    player.stopPlayback()
                    dialog.dismiss()
                }
                .setOnDismissListener { player.stopPlayback() }
                .show()
        } catch (error: Exception) {
            Log.e(TAG, "Could not open the selected video.", error)
            showToast("Could not open this video. Its access may have expired.")
        }
    }

    private fun card(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(16), dp(16), dp(16), dp(16))
        background = roundedBackground(color(R.color.surface), dp(16))
        elevation = dp(1).toFloat()
    }

    private fun text(value: String, size: Int, textColor: Int, bold: Boolean = false): TextView =
        TextView(this).apply {
            text = value
            textSize = size.toFloat()
            setTextColor(textColor)
            if (bold) setTypeface(typeface, Typeface.BOLD)
        }

    private fun button(value: String, secondary: Boolean = false, action: () -> Unit): Button =
        Button(this).apply {
            text = value
            isAllCaps = false
            textSize = 15f
            setTextColor(if (secondary) color(R.color.primary) else Color.WHITE)
            background = roundedBackground(
                if (secondary) color(R.color.secondary_button) else color(R.color.primary),
                dp(14),
            )
            setOnClickListener { action() }
        }

    private fun topMargin(value: Int) = LinearLayout.LayoutParams(-1, -2).apply {
        topMargin = dp(value)
    }

    private fun roundedBackground(fill: Int, radius: Int) = GradientDrawable().apply {
        setColor(fill)
        cornerRadius = radius.toFloat()
    }

    private fun color(resource: Int) = ContextCompat.getColor(this, resource)
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    private fun formatDate(timestamp: Long) =
        java.text.SimpleDateFormat("MMM d, yyyy · h:mm a", java.util.Locale.getDefault())
            .format(java.util.Date(timestamp))

    private fun showToast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }

    companion object {
        private const val LABEL_INTERVAL_MS = 1_200L
        private const val LIVE_EVENT_COOLDOWN_MS = 15_000L
        private const val MOTION_NOTIFICATIONS_KEY = "motion_notifications_enabled"
        private const val EVENT_RECORDING_KEY = "event_recording_enabled"
        private const val MOTION_CHANNEL_ID = "motion-alerts"
        private const val RECORDINGS_DIRECTORY = "recordings"
        private const val MAX_SAVED_RECORDINGS = 20
        private const val MAX_RECORDING_BYTES = 250L * 1024L * 1024L
        private const val RECORDING_QUIET_MS = 5_000L
        private const val MAX_EVENT_RECORDING_MS = 60_000L
        private const val RECORDING_STOP_CHECK_MS = 1_000L
        private const val BACKUP_FORMAT = "motion-organizer-reports"
        private const val BACKUP_VERSION = 1
        private const val MAX_BACKUP_BYTES = 2 * 1024 * 1024
        private const val MAX_BACKUP_EVENTS = 1_000
        private const val MAX_BACKUP_SAMPLES = 10_000_000
        private const val SAMPLE_WIDTH = 32
        private const val SAMPLE_HEIGHT = 18
        private const val PIXEL_CHANGE_THRESHOLD = 24
        private const val CHANGED_PIXEL_RATIO = 0.035f
        private const val AVERAGE_CHANGE_THRESHOLD = 5f
        private const val LABEL_CONFIDENCE = 0.45f
    }
}
