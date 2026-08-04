package fan.keubo.app

import android.Manifest
import android.content.ContentResolver
import android.content.ContentUris
import android.content.Intent
import android.database.Cursor
import android.graphics.Bitmap
import android.media.ThumbnailUtils
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import android.util.Size
import android.view.HapticFeedbackConstants
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.util.UUID
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.min

/**
 * 직관 라이브 커스텀 그리드 픽커용 사진첩 브릿지 — MediaStore 열거 + cache export.
 * 원격 로드 WebView(server.url=keubo.fan)는 content:// 경로를 읽지 못하므로 썸네일은
 * data URL, 원본은 cache export 후 base64 청크(readExport)로 전달한다.
 */
@CapacitorPlugin(
    name = "VenueMediaLibrary",
    permissions = [
        Permission(alias = "mediaLegacy", strings = [Manifest.permission.READ_EXTERNAL_STORAGE]),
        Permission(
            alias = "media",
            strings = [
                Manifest.permission.READ_MEDIA_IMAGES,
                Manifest.permission.READ_MEDIA_VIDEO,
            ],
        ),
        Permission(
            alias = "mediaPartial",
            strings = [Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED],
        ),
    ],
)
class VenueMediaLibraryPlugin : Plugin() {
    private val executor = Executors.newSingleThreadExecutor()
    private val exports = mutableMapOf<String, File>()

    override fun handleOnDestroy() {
        synchronized(exports) {
            exports.values.forEach { it.delete() }
            exports.clear()
        }
        executor.shutdown()
        super.handleOnDestroy()
    }

    /** "prompt" | "authorized" | "limited" | "denied" — iOS와 같은 JS 계약. */
    private fun currentPermission(): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (getPermissionState("media") == PermissionState.GRANTED) return "authorized"
            if (
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE &&
                getPermissionState("mediaPartial") == PermissionState.GRANTED
            ) {
                return "limited"
            }
            return if (getPermissionState("media") == PermissionState.DENIED) "denied" else "prompt"
        }
        return when (getPermissionState("mediaLegacy")) {
            PermissionState.GRANTED -> "authorized"
            PermissionState.DENIED -> "denied"
            else -> "prompt"
        }
    }

    private fun hasReadAccess(): Boolean =
        currentPermission() == "authorized" || currentPermission() == "limited"

    private fun permissionResult() = JSObject().apply {
        put("permission", currentPermission())
    }

    @PluginMethod
    fun getPermission(call: PluginCall) {
        call.resolve(permissionResult())
    }

    @PluginMethod
    fun requestPermission(call: PluginCall) {
        if (hasReadAccess() && currentPermission() != "limited") {
            call.resolve(permissionResult())
            return
        }
        when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE ->
                requestPermissionForAliases(
                    arrayOf("media", "mediaPartial"),
                    call,
                    "permissionCallback",
                )
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ->
                requestPermissionForAlias("media", call, "permissionCallback")
            else -> requestPermissionForAlias("mediaLegacy", call, "permissionCallback")
        }
    }

    @PermissionCallback
    private fun permissionCallback(call: PluginCall) {
        call.resolve(permissionResult())
    }

    /** Android 14+ '일부 사진 다시 선택' 시스템 시트. */
    @PluginMethod
    fun presentLimitedPicker(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            requestPermissionForAliases(
                arrayOf("media", "mediaPartial"),
                call,
                "permissionCallback",
            )
        } else {
            call.resolve(permissionResult())
        }
    }

    @PluginMethod
    fun listMedia(call: PluginCall) {
        if (!hasReadAccess()) {
            call.resolve(JSObject().apply {
                put("assets", JSArray())
                put("nextCursor", null)
                put("permission", currentPermission())
            })
            return
        }

        val limit = max(1, call.getInt("limit") ?: 60)
        val offset = max(0, call.getString("cursor")?.toIntOrNull() ?: 0)
        // 미디어 타입 필터 — 영상만/사진만 보기. cursor(offset)도 같은 필터된 쿼리 기준이라
        // 페이징이 그 타입 안에서만 진행한다(혼합 목록을 받아 화면에서 걸러내던 구방식과 다름).
        val requestedTypes = call.getArray("mediaTypes")?.let { array ->
            (0 until array.length()).mapNotNull { runCatching { array.getString(it) }.getOrNull() }
        }
        executor.execute {
            try {
                val resolver = context.contentResolver
                val collection = MediaStore.Files.getContentUri("external")
                val projection = arrayOf(
                    MediaStore.Files.FileColumns._ID,
                    MediaStore.Files.FileColumns.MEDIA_TYPE,
                    MediaStore.Files.FileColumns.DATE_ADDED,
                    MediaStore.Files.FileColumns.DURATION,
                )
                val selectionArgs = mediaTypeSelectionArgs(requestedTypes)
                val placeholders = selectionArgs.joinToString(", ") { "?" }
                val selection =
                    "${MediaStore.Files.FileColumns.MEDIA_TYPE} IN ($placeholders)"
                val assets = JSArray()
                var hasMore = false
                queryPage(
                    resolver,
                    collection,
                    projection,
                    selection,
                    selectionArgs,
                    limit + 1,
                    offset,
                )?.use { cursor ->
                    val idCol = cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns._ID)
                    val typeCol =
                        cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns.MEDIA_TYPE)
                    val dateCol =
                        cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns.DATE_ADDED)
                    val durationCol =
                        cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns.DURATION)
                    var emitted = 0
                    while (cursor.moveToNext()) {
                        if (emitted >= limit) {
                            hasMore = true
                            break
                        }
                        val id = cursor.getLong(idCol)
                        val isVideo =
                            cursor.getInt(typeCol) ==
                                MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO
                        val itemUri = ContentUris.withAppendedId(
                            if (isVideo) {
                                MediaStore.Video.Media.EXTERNAL_CONTENT_URI
                            } else {
                                MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                            },
                            id,
                        )
                        val durationMs = cursor.getLong(durationCol)
                        assets.put(JSObject().apply {
                            put("id", "${if (isVideo) "video" else "image"}:$id")
                            put("kind", if (isVideo) "video" else "image")
                            put("thumbnailUrl", thumbnailDataUrl(resolver, itemUri, isVideo))
                            put("durationMs", if (isVideo && durationMs > 0) durationMs else null)
                            put("createdAt", cursor.getLong(dateCol) * 1000L)
                        })
                        emitted++
                    }
                }
                call.resolve(JSObject().apply {
                    put("assets", assets)
                    put("nextCursor", if (hasMore) (offset + limit).toString() else null)
                    put("permission", currentPermission())
                })
            } catch (error: Exception) {
                call.reject("listMedia failed: ${error.message}")
            }
        }
    }

    /**
     * JS `mediaTypes`("image" | "video") → MediaStore MEDIA_TYPE selection args.
     * 미전달/빈 배열/미지 값은 기존 계약인 사진+영상 전체로 폴백한다(구웹 호환).
     */
    private fun mediaTypeSelectionArgs(requested: List<String>?): Array<String> {
        val image = MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE.toString()
        val video = MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO.toString()
        val wantsImage = requested?.contains("image") == true
        val wantsVideo = requested?.contains("video") == true
        return when {
            wantsImage && !wantsVideo -> arrayOf(image)
            wantsVideo && !wantsImage -> arrayOf(video)
            else -> arrayOf(image, video)
        }
    }

    private fun queryPage(
        resolver: ContentResolver,
        collection: Uri,
        projection: Array<String>,
        selection: String,
        selectionArgs: Array<String>,
        limit: Int,
        offset: Int,
    ): Cursor? {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val args = Bundle().apply {
                putString(ContentResolver.QUERY_ARG_SQL_SELECTION, selection)
                putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, selectionArgs)
                putStringArray(
                    ContentResolver.QUERY_ARG_SORT_COLUMNS,
                    arrayOf(MediaStore.Files.FileColumns.DATE_ADDED),
                )
                putInt(
                    ContentResolver.QUERY_ARG_SORT_DIRECTION,
                    ContentResolver.QUERY_SORT_DIRECTION_DESCENDING,
                )
                putInt(ContentResolver.QUERY_ARG_LIMIT, limit)
                putInt(ContentResolver.QUERY_ARG_OFFSET, offset)
            }
            return resolver.query(collection, projection, args, null)
        }
        val sortOrder =
            "${MediaStore.Files.FileColumns.DATE_ADDED} DESC LIMIT $limit OFFSET $offset"
        return resolver.query(collection, projection, selection, selectionArgs, sortOrder)
    }

    @Suppress("DEPRECATION")
    private fun thumbnailDataUrl(
        resolver: ContentResolver,
        uri: Uri,
        isVideo: Boolean,
    ): String {
        return try {
            var bitmap: Bitmap? =
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    resolver.loadThumbnail(uri, Size(240, 240), null)
                } else {
                    val id = ContentUris.parseId(uri)
                    if (isVideo) {
                        MediaStore.Video.Thumbnails.getThumbnail(
                            resolver,
                            id,
                            MediaStore.Video.Thumbnails.MINI_KIND,
                            null,
                        )
                    } else {
                        MediaStore.Images.Thumbnails.getThumbnail(
                            resolver,
                            id,
                            MediaStore.Images.Thumbnails.MINI_KIND,
                            null,
                        )
                    }
                }
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && bitmap != null) {
                bitmap = ThumbnailUtils.extractThumbnail(bitmap, 240, 240)
            }
            if (bitmap == null) return ""
            val out = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.JPEG, 70, out)
            bitmap.recycle()
            "data:image/jpeg;base64," +
                Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        } catch (_: Exception) {
            ""
        }
    }

    @PluginMethod
    fun exportMedia(call: PluginCall) {
        val rawId = call.getString("id")
        if (rawId == null || !rawId.contains(":")) {
            call.reject("id is required")
            return
        }
        val isVideo = rawId.startsWith("video:")
        val mediaId = rawId.substringAfter(":").toLongOrNull()
        if (mediaId == null) {
            call.reject("invalid id")
            return
        }

        executor.execute {
            try {
                val resolver = context.contentResolver
                val uri = ContentUris.withAppendedId(
                    if (isVideo) {
                        MediaStore.Video.Media.EXTERNAL_CONTENT_URI
                    } else {
                        MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                    },
                    mediaId,
                )
                var fileName = if (isVideo) "video.mp4" else "photo.jpg"
                var mimeType = if (isVideo) "video/mp4" else "image/jpeg"
                var lastModified = System.currentTimeMillis()
                resolver.query(
                    uri,
                    arrayOf(
                        MediaStore.MediaColumns.DISPLAY_NAME,
                        MediaStore.MediaColumns.MIME_TYPE,
                        MediaStore.MediaColumns.DATE_MODIFIED,
                    ),
                    null,
                    null,
                    null,
                )?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        cursor.getString(0)?.takeIf { it.isNotBlank() }?.let { fileName = it }
                        cursor.getString(1)?.takeIf { it.isNotBlank() }?.let { mimeType = it }
                        cursor.getLong(2).takeIf { it > 0 }?.let { lastModified = it * 1000L }
                    }
                }
                val dir = File(context.cacheDir, "venue-media-exports").apply { mkdirs() }
                val token = UUID.randomUUID().toString()
                val destination = File(dir, "$token-${File(fileName).name}")
                resolver.openInputStream(uri).use { input ->
                    requireNotNull(input) { "open failed" }
                    FileOutputStream(destination).use { output -> input.copyTo(output, 64 * 1024) }
                }
                synchronized(exports) { exports[token] = destination }
                call.resolve(JSObject().apply {
                    put("token", token)
                    put("fileName", fileName)
                    put("mimeType", mimeType)
                    put("size", destination.length())
                    put("lastModified", lastModified)
                })
            } catch (error: Exception) {
                call.reject("export failed: ${error.message}")
            }
        }
    }

    @PluginMethod
    fun readExport(call: PluginCall) {
        val token = call.getString("token")
        val offset = max(0, call.getInt("offset") ?: 0)
        val length = max(0, call.getInt("length") ?: 0)
        val file = synchronized(exports) { token?.let(exports::get) }
        if (file == null) {
            call.reject("export not found")
            return
        }
        executor.execute {
            try {
                RandomAccessFile(file, "r").use { input ->
                    val available = max(0L, input.length() - offset.toLong())
                    val toRead = min(length.toLong(), available).toInt()
                    val bytes = ByteArray(toRead)
                    input.seek(offset.toLong())
                    input.readFully(bytes)
                    call.resolve(JSObject().apply {
                        put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
                    })
                }
            } catch (error: Exception) {
                call.reject("read failed: ${error.message}")
            }
        }
    }

    @PluginMethod
    fun releaseExport(call: PluginCall) {
        val token = call.getString("token")
        val file = synchronized(exports) { token?.let(exports::remove) }
        file?.delete()
        call.resolve()
    }

    @PluginMethod
    fun openSettings(call: PluginCall) {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.fromParts("package", context.packageName, null)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
        call.resolve()
    }

    @PluginMethod
    fun selectionChanged(call: PluginCall) {
        activity?.window?.decorView?.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
        call.resolve()
    }
}
