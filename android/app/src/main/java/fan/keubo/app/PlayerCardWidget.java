package fan.keubo.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.os.Bundle;
import android.view.View;
import android.widget.RemoteViews;

import androidx.core.content.res.ResourcesCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * 최애선수 스탯 카드 홈 위젯(4x2 기본, 세로 리사이즈) — 홈 최애선수 카드(FavoritePlayersSection)와 동일 디자인.
 * 히어로샷 + 헤드라인(최근 3경기 타율/최근 9이닝 ERA) + 주간 페이스 스파크라인 + 시즌 라인
 * + 부문 타이틀 뱃지, 라이브/당일 경기엔 '오늘 경기' 활약 섹션 삽입.
 *
 * 데이터는 /api/widget/player-card 단일 조합 API(문자열 포맷 서버 완결)를 위젯이 직접
 * fetch(30분 주기 + 10분 신선 캐시). 라이브 중엔 game_live FCM 틱에 편승해 재조회(스로틀),
 * 경기 종료 game_end FCM 시 즉시 재조회. 표시 선수는 위젯 추가 시 config에서 선택
 * (PlayerCardWidgetConfigure, 최애선수 목록은 앱이 setFavPlayers 브리지로 prefs에 동기화).
 *
 * 렌더는 카드 전체를 Canvas 비트맵 1장(폭 기준 균일 스케일 = 목업 비율 고정)으로 그려
 * ImageView에 세팅 — RemoteViews 폰트/뷰 제약 회피(팀순위 위젯과 동일 방식).
 */
public class PlayerCardWidget extends AppWidgetProvider {

    static final String PREFS = "kbo_player_widget";
    static final String KEY_PLAYER_PREFIX = "player_";   // player_<widgetId> = kboId
    static final String KEY_DATA_PREFIX = "data_";       // data_<kboId> = 응답 JSON
    static final String KEY_UPDATED_PREFIX = "updated_"; // updated_<kboId> = epoch ms
    static final String KEY_IMG_URL_PREFIX = "imgurl_";  // imgurl_<kboId> = 캐시된 이미지 URL
    static final String KEY_FAV_PLAYERS = "fav_players"; // 앱이 동기화한 최애선수 목록 JSON

    private static final String API_BASE = "https://keubo.fan";
    private static final long FRESH_MS = 10 * 60 * 1000L;
    private static final long LIVE_TICK_MS = 55 * 1000L; // game_live 매분 틱 스로틀

    // 하이라이트/팀 컬러 — 앱 getTeamBgColor(다크) 실효값(TeamRankWidget과 동일 팔레트)
    private static final int[] TEAM_COLOR = {
        0, 0xFFC60C30, 0xFF9BA8D4, 0xFFE85050, 0xFFCE0E2D, 0xFF315288,
        0xFFEA0029, 0xFF6BC4E8, 0xFF074CA1, 0xFFFF6600, 0xFFC97088,
    };

    // 다크 테마 토큰(globals.css .dark)
    private static final int C_CARD = 0xFF141416;          // --bg-secondary
    private static final int C_BORDER = 0x14FFFFFF;        // --border(white 8%)
    private static final int C_TEXT = 0xFFF5F5F7;
    private static final int C_TERTIARY = 0xFF8E8E93;
    private static final int C_UP = 0xFF34C759;            // ▲ improving
    private static final int C_DOWN = 0xFFFF453A;          // ▼ declining
    private static final int C_LIVE = 0xFFF87171;          // LIVE pill(red-400)

    @Override
    public void onUpdate(Context context, AppWidgetManager mgr, int[] appWidgetIds) {
        renderIds(context, mgr, appWidgetIds);

        // 캐시가 오래된 선수만 백그라운드 fetch 후 재렌더.
        // goAsync()는 실제 receiver 콜백에서만 유효 — 수동 갱신은 renderAllFromCache 사용.
        List<String> stale = stalePlayers(context, appWidgetIds, FRESH_MS);
        if (!stale.isEmpty()) {
            final PendingResult pr = goAsync();
            final Context app = context.getApplicationContext();
            new Thread(() -> {
                try {
                    boolean any = false;
                    for (String id : stale) any |= fetchAndStore(app, id);
                    if (any) renderAllFromCache(app);
                } finally {
                    pr.finish();
                }
            }).start();
        }
    }

    @Override
    public void onAppWidgetOptionsChanged(Context context, AppWidgetManager mgr,
                                          int appWidgetId, Bundle newOptions) {
        renderIds(context, mgr, new int[] { appWidgetId });
    }

    @Override
    public void onDeleted(Context context, int[] appWidgetIds) {
        SharedPreferences.Editor e = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        for (int id : appWidgetIds) e.remove(KEY_PLAYER_PREFIX + id);
        e.apply();
    }

    private static void renderIds(Context ctx, AppWidgetManager mgr, int[] ids) {
        Intent launch = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        PendingIntent pi = PendingIntent.getActivity(
            ctx, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        for (int id : ids) {
            RemoteViews v = buildViews(ctx, mgr, id);
            v.setOnClickPendingIntent(R.id.widget_player_root, pi);
            mgr.updateAppWidget(id, v);
        }
    }

    /** 배치된 모든 카드 위젯을 현재 캐시로 재렌더 — fetch 없음(수동 갱신 경로 전용). */
    static void renderAllFromCache(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, PlayerCardWidget.class));
        if (ids == null || ids.length == 0) return;
        renderIds(ctx, mgr, ids);
    }

    /** 모든 설정 선수 강제 재조회 후 재렌더 — 경기 종료 FCM(game_end). 위젯 미배치면 no-op. */
    static void fetchAndRefresh(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, PlayerCardWidget.class));
        if (ids == null || ids.length == 0) return;
        final Context app = ctx.getApplicationContext();
        final List<String> players = stalePlayers(app, ids, 0);
        new Thread(() -> {
            for (String id : players) fetchAndStore(app, id);
            renderAllFromCache(app);
        }).start();
    }

    /** game_live 매분 FCM 틱 편승 — 55초 스로틀로 설정 선수 재조회(라이브 활약 갱신). */
    static void onLiveTick(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, PlayerCardWidget.class));
        if (ids == null || ids.length == 0) return;
        final Context app = ctx.getApplicationContext();
        final List<String> players = stalePlayers(app, ids, LIVE_TICK_MS);
        if (players.isEmpty()) return;
        new Thread(() -> {
            boolean any = false;
            for (String id : players) any |= fetchAndStore(app, id);
            if (any) renderAllFromCache(app);
        }).start();
    }

    /** 배치 위젯들의 설정 선수 중 캐시가 maxAge보다 오래된 선수 kboId 목록(중복 제거). */
    private static List<String> stalePlayers(Context ctx, int[] ids, long maxAgeMs) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long now = System.currentTimeMillis();
        Set<String> seen = new HashSet<>();
        List<String> out = new ArrayList<>();
        for (int id : ids) {
            String player = p.getString(KEY_PLAYER_PREFIX + id, "");
            if (player.isEmpty() || !seen.add(player)) continue;
            if (now - p.getLong(KEY_UPDATED_PREFIX + player, 0) > maxAgeMs) out.add(player);
        }
        return out;
    }

    /** /api/widget/player-card GET → prefs 캐시 + 선수 이미지 파일 캐시. 성공 시 true. */
    static boolean fetchAndStore(Context ctx, String kboId) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(
                API_BASE + "/api/widget/player-card?id=" + kboId).openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setRequestProperty("User-Agent", "kbo-everyday-widget/1.0");
            if (conn.getResponseCode() != 200) return false;
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(
                    new InputStreamReader(conn.getInputStream(), "UTF-8"))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
            }
            JSONObject json = new JSONObject(sb.toString());
            if (json.optJSONObject("player") == null) return false;
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(KEY_DATA_PREFIX + kboId, json.toString())
                .putLong(KEY_UPDATED_PREFIX + kboId, System.currentTimeMillis())
                .apply();
            cachePlayerImage(ctx, kboId, json.optJSONObject("player"));
            return true;
        } catch (Exception e) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** 히어로샷(우선)/헤드샷 이미지를 파일로 캐시. URL이 바뀌면 재다운로드. */
    private static void cachePlayerImage(Context ctx, String kboId, JSONObject player) {
        if (player == null) return;
        String url = player.optString("heroUrl", "");
        if (url.isEmpty() || "null".equals(url)) url = player.optString("photoUrl", "");
        if (url.isEmpty() || "null".equals(url)) return;
        if (!url.startsWith("http")) url = API_BASE + url;
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        File f = imageFile(ctx, kboId);
        if (f.exists() && url.equals(p.getString(KEY_IMG_URL_PREFIX + kboId, ""))) return;
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setRequestProperty("User-Agent", "kbo-everyday-widget/1.0");
            if (conn.getResponseCode() != 200) return;
            try (InputStream in = conn.getInputStream();
                 FileOutputStream out = new FileOutputStream(f)) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
            p.edit().putString(KEY_IMG_URL_PREFIX + kboId, url).apply();
        } catch (Exception ignored) {
            //noinspection ResultOfMethodCallIgnored
            f.delete();
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static File imageFile(Context ctx, String kboId) {
        return new File(ctx.getFilesDir(), "player_card_" + kboId + ".img");
    }

    // ── 렌더 ─────────────────────────────────────────────────────────────

    private static RemoteViews buildViews(Context ctx, AppWidgetManager mgr, int widgetId) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_player_card);
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String kboId = p.getString(KEY_PLAYER_PREFIX + widgetId, "");
        JSONObject data = null;
        try {
            String raw = kboId.isEmpty() ? "" : p.getString(KEY_DATA_PREFIX + kboId, "");
            if (!raw.isEmpty()) data = new JSONObject(raw);
        } catch (Exception ignored) { }

        if (data == null) {
            v.setViewVisibility(R.id.widget_player_img, View.GONE);
            v.setViewVisibility(R.id.widget_player_empty, View.VISIBLE);
            v.setTextViewText(R.id.widget_player_empty, kboId.isEmpty()
                ? "위젯을 길게 눌러 제거 후 다시 추가해\n최애선수를 선택해주세요"
                : "선수 정보를 불러오는 중이에요");
            return v;
        }
        v.setViewVisibility(R.id.widget_player_img, View.VISIBLE);
        v.setViewVisibility(R.id.widget_player_empty, View.GONE);

        Bundle opt = mgr.getAppWidgetOptions(widgetId);
        int wDp = opt.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0);
        int hDp = opt.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0);
        if (wDp <= 0) wDp = 320;
        wDp = Math.max(250, Math.min(wDp, 500));
        if (hDp > 0) hDp = Math.max(100, Math.min(hDp, 500)); // 4x2 기본(≈110~150dp) 허용

        Bitmap hero = null;
        try {
            File f = imageFile(ctx, kboId);
            if (f.exists()) hero = BitmapFactory.decodeFile(f.getAbsolutePath());
        } catch (Exception ignored) { }

        v.setImageViewBitmap(R.id.widget_player_img, renderCard(ctx, data, hero, wDp, hDp));
        return v;
    }

    /**
     * 카드 렌더 — 디자인 기준폭 340dp의 균일 스케일(목업 비율 고정). 높이는 내용에서 유도되고
     * ImageView fitCenter가 셀에 맞춘다. 폰트: 숫자/영문=Montserrat, 한글=Noto Sans KR.
     */
    static Bitmap renderCard(Context ctx, JSONObject data, Bitmap hero, int wDp, int hDp) {
        float d = ctx.getResources().getDisplayMetrics().density;
        while (wDp * d > 1500f && d > 1f) d -= 0.5f; // 비트맵 폭 가드
        float u = d * Math.min(1f, wDp / 340f);

        JSONObject player = data.optJSONObject("player");
        JSONObject headline = data.optJSONObject("headline");
        JSONObject today = data.optJSONObject("today");
        boolean showToday = today != null && today.optBoolean("show", false);
        JSONArray weeklyArr = data.optJSONArray("weekly");
        JSONArray titlesArr = data.optJSONArray("titles");
        int teamId = player != null ? player.optInt("teamId", 0) : 0;
        int team = teamId >= 1 && teamId <= 10 ? TEAM_COLOR[teamId] : 0xFFE85050;

        Typeface mont = font(ctx, R.font.montserrat_vf, Typeface.DEFAULT_BOLD);
        Typeface noto = font(ctx, R.font.notosanskr_vf, Typeface.DEFAULT);

        // 뱃지 줄바꿈 선계산(내용 높이 산출) — 디자인 폭 기준이라 결정적.
        // 셀이 자연 높이보다 "작으면"(4x2 compact) u를 스케일-투-핏으로 줄여 전체 콘텐츠를
        // 균일 축소해 우겨넣는다(2-pass: 축소된 u로 뱃지 줄바꿈·높이 재계산).
        float W = wDp * d;
        float padH = 0;
        List<List<String>> badgeRows = null;
        float headerH = 0, todayH = 0, badgesH = 0, naturalH = 0;
        for (int pass = 0; pass < 2; pass++) {
            padH = 14 * u;
            badgeRows = new ArrayList<>();
            if (titlesArr != null && titlesArr.length() > 0) {
                List<String> row = new ArrayList<>();
                float bx = padH;
                for (int i = 0; i < titlesArr.length(); i++) {
                    String label = (i == 0 ? "🏆 " : "") + titlesArr.optString(i, "");
                    float bw = measureMixed(label, 11 * u, mont, noto, true) + 14 * u;
                    if (bx + bw > W - padH && !row.isEmpty()) {
                        badgeRows.add(row);
                        row = new ArrayList<>();
                        bx = padH;
                    }
                    row.add(label);
                    bx += bw + 6 * u;
                }
                if (!row.isEmpty()) badgeRows.add(row);
            }
            headerH = 120 * u;
            todayH = showToday ? 59 * u : 0;
            badgesH = badgeRows.isEmpty() ? 0 : (20 * u + 6 * u) * badgeRows.size() - 6 * u + 20 * u;
            naturalH = Math.max(headerH + d + todayH + badgesH, 130 * u);
            if (pass == 0 && hDp > 0 && hDp * d < naturalH) {
                u *= Math.max(0.58f, hDp * d / naturalH);
                continue;
            }
            break;
        }

        // 셀 높이 채우기(fill-height): 셀이 카드 자연 높이보다 크면 여분을 헤더 확장(히어로 확대,
        // 정보 블록 수직 센터링)과 뱃지 위 공백으로 분배 — 위아래 레터박스 여백 제거.
        float infoShift = 0;
        int H = (int) naturalH;
        if (hDp > 0 && hDp * d > naturalH) {
            float extra = hDp * d - naturalH;
            float headerExtra = Math.min(extra * 0.6f, 70 * u); // 헤더 과대 확장 방지
            headerH += headerExtra;
            infoShift = headerExtra / 2;
            H = (int) (hDp * d);
        }

        Bitmap bmp = Bitmap.createBitmap((int) W, H, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(bmp);
        Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        RectF card = new RectF(0, 0, W, H);
        fill.setColor(C_CARD);
        cv.drawRoundRect(card, 16 * u, 16 * u, fill);

        // ── 히어로 패널(좌 108u): 팀컬러 그라데이션 + 컷아웃(상단 헤드룸, 하단 정렬)
        cv.save();
        Path clip = new Path();
        clip.addRoundRect(card, 16 * u, 16 * u, Path.Direction.CW);
        cv.clipPath(clip);
        float panelW = 108 * u;
        Paint grad = new Paint(Paint.ANTI_ALIAS_FLAG);
        grad.setShader(new LinearGradient(0, 0, panelW * 0.72f, headerH * 0.72f,
            (team & 0x00FFFFFF) | 0x1F000000, 0x00000000, Shader.TileMode.CLAMP));
        cv.drawRect(0, 0, panelW, headerH, grad);
        if (hero != null) {
            boolean isHero = hero.hasAlpha(); // 컷아웃(webp 투명) vs 헤드샷(jpg)
            Paint bp = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
            if (isHero) {
                float availH = headerH - 16 * u;
                float sc = Math.min(availH / hero.getHeight(), panelW / hero.getWidth());
                float hw = hero.getWidth() * sc, hh = hero.getHeight() * sc;
                float hx = (panelW - hw) / 2, hy = headerH - hh;
                cv.drawBitmap(hero, null, new RectF(hx, hy, hx + hw, hy + hh), bp);
            } else {
                // 헤드샷 폴백 — 중앙 원형 72u
                float r = 36 * u, cx = panelW / 2, cy = headerH / 2;
                BitmapShader sh = new BitmapShader(hero, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP);
                Matrix m = new Matrix();
                float sc = Math.max(2 * r / hero.getWidth(), 2 * r / hero.getHeight());
                m.setScale(sc, sc);
                m.postTranslate(cx - hero.getWidth() * sc / 2, cy - hero.getHeight() * sc / 2);
                sh.setLocalMatrix(m);
                Paint cp = new Paint(Paint.ANTI_ALIAS_FLAG);
                cp.setShader(sh);
                cv.drawCircle(cx, cy, r, cp);
            }
        }
        cv.restore();

        // ── 정보 영역
        float ix = panelW + 10 * u;
        float rx = W - padH;
        String name = player != null ? player.optString("name", "") : "";
        int number = player != null ? player.optInt("number", 0) : 0;
        String position = player != null ? player.optString("position", "") : "";
        drawMixed(cv, name, ix, 27 * u + infoShift, 16 * u, C_TEXT, 0, mont, noto, true);
        drawMixed(cv, (number > 0 ? "#" + number + " " : "") + position,
            ix, 45 * u + infoShift, 12 * u, C_TERTIARY, 0, mont, noto, false);

        if (headline != null) {
            String dir = headline.optString("direction", "stable");
            boolean hasArrow = "improving".equals(dir) || "declining".equals(dir);
            float tri = 9 * u;
            float valRight = hasArrow ? rx - tri - 4 * u : rx;
            drawMixed(cv, headline.optString("label", ""), rx, 22 * u + infoShift, 11 * u, C_TERTIARY, 1, mont, noto, false);
            drawMixed(cv, headline.optString("value", ""), valRight, 45 * u + infoShift, 22 * u, C_TEXT, 1, mont, noto, true);
            if (hasArrow) {
                boolean up = "improving".equals(dir);
                Path tp = new Path();
                float ty = (up ? 45 * u - 1 * u : 45 * u - 7 * u) + infoShift;
                if (up) {
                    tp.moveTo(rx - tri / 2, ty - tri * 0.8f);
                    tp.lineTo(rx - tri, ty);
                    tp.lineTo(rx, ty);
                } else {
                    tp.moveTo(rx - tri, ty);
                    tp.lineTo(rx, ty);
                    tp.lineTo(rx - tri / 2, ty + tri * 0.8f);
                }
                tp.close();
                fill.setColor(up ? C_UP : C_DOWN);
                cv.drawPath(tp, fill);
            }
        }

        // 주간 페이스 스파크라인
        float[] weekly = toFloats(weeklyArr);
        boolean isPitcher = player != null && player.optBoolean("isPitcher", false);
        if (weekly.length >= 2) {
            drawMixed(cv, "시즌 주간 페이스 · " + (isPitcher ? "ERA" : "타율"),
                ix, 62 * u + infoShift, 10 * u, C_TERTIARY, 0, mont, noto, false);
            float vmin = Float.MAX_VALUE, vmax = -Float.MAX_VALUE;
            for (float f : weekly) { vmin = Math.min(vmin, f); vmax = Math.max(vmax, f); }
            float pad = Math.max((vmax - vmin) * 0.15f, isPitcher ? 0.3f : 0.01f);
            vmin -= pad; vmax += pad;
            float sy0 = 67 * u + infoShift, sy1 = 91 * u + infoShift;
            Paint line = new Paint(Paint.ANTI_ALIAS_FLAG);
            line.setStyle(Paint.Style.STROKE);
            line.setStrokeWidth(2 * u);
            line.setStrokeCap(Paint.Cap.ROUND);
            line.setStrokeJoin(Paint.Join.ROUND);
            line.setColor(team);
            Path sp = new Path();
            for (int i = 0; i < weekly.length; i++) {
                float x = ix + (rx - ix) * i / (weekly.length - 1);
                float y = sy1 - (sy1 - sy0) * (weekly[i] - vmin) / (vmax - vmin);
                if (i == 0) sp.moveTo(x, y); else sp.lineTo(x, y);
            }
            cv.drawPath(sp, line);
        }
        String seasonLine = data.optString("seasonLine", "");
        if (!seasonLine.isEmpty() && !"null".equals(seasonLine)) {
            drawMixed(cv, seasonLine, ix, 106 * u + infoShift, 10 * u, C_TERTIARY, 0, mont, noto, false);
        } else if (headline == null) {
            // 시즌 기록 없는 선수(신인 등) — 앱 카드와 동일 안내
            drawMixed(cv, "2026 시즌 기록 준비 중", ix, 68 * u + infoShift, 12 * u, C_TERTIARY, 0, mont, noto, false);
        }

        float y = headerH;
        fill.setColor(C_BORDER);
        cv.drawRect(padH, y, W - padH, y + d, fill);

        // ── 오늘 경기 활약(라이브~당일)
        if (showToday) {
            float ly = y + 10 * u;
            float lx = padH;
            drawMixed(cv, "오늘 경기", lx, ly + 10 * u, 10 * u, C_TERTIARY, 0, mont, noto, true);
            float cursor = lx + measureMixed("오늘 경기", 10 * u, mont, noto, true) + 6 * u;
            if (today.optBoolean("isLive", false)) {
                float ph = 13 * u;
                RectF pill = new RectF(cursor, ly + 1 * u, cursor + 34 * u, ly + 1 * u + ph);
                fill.setColor((C_LIVE & 0x00FFFFFF) | 0x33000000);
                cv.drawRoundRect(pill, ph / 2, ph / 2, fill);
                drawMixed(cv, "LIVE", pill.centerX(), ly + 11 * u, 9 * u, C_LIVE, 2, mont, noto, true);
                cursor = pill.right + 6 * u;
            }
            String opp = today.optString("opponentName", "");
            if (!opp.isEmpty() && !"null".equals(opp)) {
                drawMixed(cv, "vs " + opp, cursor, ly + 10 * u, 10 * u, C_TERTIARY, 0, mont, noto, false);
            }
            float ry = ly + 33 * u;
            String lineTxt = today.optString("line", "");
            drawMixed(cv, lineTxt, lx, ry, 15 * u, C_TEXT, 0, mont, noto, true);
            float cx = lx + measureMixed(lineTxt, 15 * u, mont, noto, true) + 8 * u;
            String decision = today.optString("decision", "");
            if (!decision.isEmpty() && !"null".equals(decision)) {
                float cw = measureMixed(decision, 11 * u, mont, noto, true) + 12 * u;
                float ch = 18 * u;
                RectF r = new RectF(cx, ry - 13 * u, cx + cw, ry - 13 * u + ch);
                fill.setColor(team);
                cv.drawRoundRect(r, ch / 2, ch / 2, fill);
                drawMixed(cv, decision, r.centerX(), ry + 0.5f * u, 11 * u, 0xFFFFFFFF, 2, mont, noto, true);
                cx = r.right + 6 * u;
            }
            JSONArray chips = today.optJSONArray("chips");
            if (chips != null) {
                for (int i = 0; i < chips.length(); i++) {
                    String chip = chips.optString(i, "");
                    if (chip.isEmpty()) continue;
                    float cw = measureMixed(chip, 11 * u, mont, noto, true) + 12 * u;
                    float ch = 18 * u;
                    if (cx + cw > rx) break;
                    RectF r = new RectF(cx, ry - 13 * u, cx + cw, ry - 13 * u + ch);
                    fill.setColor((team & 0x00FFFFFF) | 0x1F000000);
                    cv.drawRoundRect(r, ch / 2, ch / 2, fill);
                    drawMixed(cv, chip, r.centerX(), ry + 0.5f * u, 11 * u, team, 2, mont, noto, true);
                    cx = r.right + 6 * u;
                }
            }
            y += todayH;
            fill.setColor(C_BORDER);
            cv.drawRect(padH, y, W - padH, y + d, fill);
        }

        // ── 최근 경기 — 오늘 경기 섹션이 없을 때만, 남는 세로 공간에 맞춰 2~3줄 적응형
        JSONArray recent = data.optJSONArray("recentGames");
        if (!showToday && recent != null && recent.length() > 0) {
            float ly = y + 12 * u;
            float ry = ly + 22 * u;
            float rowH = 26 * u;
            float badgeTop = badgeRows.isEmpty() ? H
                : H - (badgeRows.size() * 26 * u - 6 * u) - 12 * u;
            // 라벨+첫 줄도 안 들어가면(4x2 compact 등) 섹션 통째 생략 — 뱃지와 겹침 방지
            if (ry + rowH <= badgeTop - 4 * u) {
            drawMixed(cv, "최근 경기", padH, ly + 10 * u, 10 * u, C_TERTIARY, 0, mont, noto, true);
            for (int i = 0; i < Math.min(recent.length(), 3); i++) {
                if (ry + rowH > badgeTop - 4 * u) break;
                JSONObject g = recent.optJSONObject(i);
                if (g == null) continue;
                String meta = g.optString("date", "") + " " + g.optString("opponent", "");
                drawMixed(cv, meta, padH, ry + 14 * u, 10 * u, C_TERTIARY, 0, mont, noto, false);
                float lxp = padH + 74 * u;
                String lineT = g.optString("line", "");
                drawMixed(cv, lineT, lxp, ry + 14 * u, 12 * u, C_TEXT, 0, mont, noto, true);
                String dec = g.optString("decision", "");
                if (!dec.isEmpty() && !"null".equals(dec)) {
                    float cx2 = lxp + measureMixed(lineT, 12 * u, mont, noto, true) + 8 * u;
                    float cw = measureMixed(dec, 10 * u, mont, noto, true) + 12 * u;
                    float chh = 16 * u;
                    RectF rr = new RectF(cx2, ry + 2 * u, cx2 + cw, ry + 2 * u + chh);
                    fill.setColor((team & 0x00FFFFFF) | 0x1F000000);
                    cv.drawRoundRect(rr, chh / 2, chh / 2, fill);
                    drawMixed(cv, dec, rr.centerX(), ry + 14 * u, 10 * u, team, 2, mont, noto, true);
                }
                ry += rowH;
            }
            }
        }

        // ── 부문 타이틀 뱃지 — 하단 고정(fill 시 여분 공백은 위 섹션과 뱃지 사이로)
        float by = badgeRows.isEmpty() ? y + 10 * u
            : Math.max(y + 10 * u, H - (badgeRows.size() * 26 * u - 6 * u) - 12 * u);
        for (List<String> row : badgeRows) {
            float bx = padH;
            float bh = 20 * u;
            for (String b : row) {
                float bw = measureMixed(b, 11 * u, mont, noto, true) + 14 * u;
                RectF r = new RectF(bx, by, bx + bw, by + bh);
                fill.setColor((team & 0x00FFFFFF) | 0x1F000000);
                cv.drawRoundRect(r, bh / 2, bh / 2, fill);
                drawMixed(cv, b, r.centerX(), by + 14 * u, 11 * u, team, 2, mont, noto, true);
                bx = r.right + 6 * u;
            }
            by += 26 * u;
        }

        // 외곽 보더
        Paint border = new Paint(Paint.ANTI_ALIAS_FLAG);
        border.setStyle(Paint.Style.STROKE);
        border.setStrokeWidth(d);
        border.setColor(C_BORDER);
        cv.drawRoundRect(new RectF(d / 2, d / 2, W - d / 2, H - d / 2), 16 * u, 16 * u, border);
        return bmp;
    }

    private static float[] toFloats(JSONArray arr) {
        if (arr == null) return new float[0];
        float[] out = new float[arr.length()];
        for (int i = 0; i < arr.length(); i++) out[i] = (float) arr.optDouble(i, 0);
        return out;
    }

    private static Typeface font(Context ctx, int res, Typeface fallback) {
        try {
            Typeface t = ResourcesCompat.getFont(ctx, res);
            return t != null ? t : fallback;
        } catch (Exception e) {
            return fallback;
        }
    }

    private static final int ALIGN_LEFT = 0;
    private static final int ALIGN_RIGHT = 1;
    private static final int ALIGN_CENTER = 2;

    private static boolean isHangul(char c) {
        return (c >= 0xAC00 && c <= 0xD7A3) || (c >= 0x1100 && c <= 0x11FF)
            || (c >= 0x3130 && c <= 0x318F);
    }

    private static Paint textPaint(Typeface t, float sizePx, int color, boolean bold, boolean hangul) {
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setTypeface(t);
        p.setTextSize(sizePx);
        p.setColor(color);
        p.setLetterSpacing(hangul ? -0.04f : -0.02f);
        p.setSubpixelText(true);
        if (bold) p.setFakeBoldText(true);
        return p;
    }

    private static float measureMixed(String text, float sizePx, Typeface mont, Typeface noto, boolean bold) {
        if (text == null || text.isEmpty()) return 0;
        Paint pm = textPaint(mont, sizePx, 0, bold, false);
        Paint pn = textPaint(noto, sizePx, 0, bold, true);
        float w = 0;
        int i = 0;
        while (i < text.length()) {
            int j = i;
            boolean h = isHangul(text.charAt(i));
            while (j < text.length() && isHangul(text.charAt(j)) == h) j++;
            w += (h ? pn : pm).measureText(text.substring(i, j));
            i = j;
        }
        return w;
    }

    /** 혼합 텍스트 캔버스 렌더 — 숫자/영문=Montserrat, 한글=Noto Sans KR(팀순위 위젯과 동일 규칙). */
    private static void drawMixed(Canvas cv, String text, float x, float baseline,
                                  float sizePx, int color, int align,
                                  Typeface mont, Typeface noto, boolean bold) {
        if (text == null || text.isEmpty()) return;
        Paint pm = textPaint(mont, sizePx, color, bold, false);
        Paint pn = textPaint(noto, sizePx, color, bold, true);
        float w = 0;
        int i = 0;
        while (i < text.length()) {
            int j = i;
            boolean h = isHangul(text.charAt(i));
            while (j < text.length() && isHangul(text.charAt(j)) == h) j++;
            w += (h ? pn : pm).measureText(text.substring(i, j));
            i = j;
        }
        float sx = align == ALIGN_RIGHT ? x - w : align == ALIGN_CENTER ? x - w / 2 : x;
        i = 0;
        while (i < text.length()) {
            int j = i;
            boolean h = isHangul(text.charAt(i));
            while (j < text.length() && isHangul(text.charAt(j)) == h) j++;
            String run = text.substring(i, j);
            Paint p = h ? pn : pm;
            cv.drawText(run, sx, baseline, p);
            sx += p.measureText(run);
            i = j;
        }
    }
}
