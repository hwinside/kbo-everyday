package fan.keubo.app;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.os.Bundle;
import android.view.View;
import android.widget.RemoteViews;

import androidx.core.content.ContextCompat;
import androidx.core.content.res.ResourcesCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Map;

/**
 * 팀 순위표 홈 위젯 — 앱 순위표(standings 탭)와 동일 디자인.
 * 컬럼: # / 팀(로고+약어) / 승 / 패 / 무 / 승률 / 차 / 연속. 최애팀 행은
 * 앱과 동일하게 팀 컬러 배경(α 0x18) + 좌측 3dp 컬러 바로 하이라이트.
 *
 * 렌더: 표 전체를 Canvas 비트맵 하나로 그려 ImageView에 세팅.
 * (RemoteViews로 10행×8컬럼을 개별 뷰로 만들면 텍스트 비트맵 80장+ — Binder
 * 전송량·XML id 관리가 비대해져, 기존 textBitmap 방식을 카드 단위로 확장했다.
 * 폰트도 숫자/영문=Montserrat, 한글=Noto Sans KR 그대로 — 런처 폰트 무시 문제 없음.)
 *
 * 데이터: 순위는 하루 단위 변동이라 라이브 위젯(FCM 매분 push)과 달리 위젯이 직접
 * /api/standings를 주기 fetch(30분, updatePeriodMillis) + 경기 종료 FCM(game_end)
 * 수신 시 재조회. 응답 JSON은 prefs(kbo_rank_widget)에 캐시해 오프라인에도 렌더.
 * 최애팀 코드는 GameScoreWidget prefs(my_team)를 공유한다.
 */
public class TeamRankWidget extends AppWidgetProvider {

    static final String PREFS = "kbo_rank_widget";
    static final String KEY_ROWS = "rows";        // /api/standings의 standings 배열 JSON 원문
    static final String KEY_UPDATED = "updated_at";

    private static final String API_URL = "https://keubo.fan/api/standings";
    // 캐시가 이보다 신선하면 네트워크 fetch 생략(위젯 리사이즈/재부팅 등 잦은 onUpdate 보호)
    private static final long FRESH_MS = 10 * 60 * 1000L;

    // teamId(앱 TEAMS 상수와 동일) → KBO 2자 코드(로고 drawable teamlogo_{code})
    private static final String[] CODE_BY_ID = {
        "", "lg", "ob", "kt", "sk", "nc", "ht", "lt", "ss", "hh", "wo",
    };
    // 최애팀 코드(kbo_game_widget my_team, 대문자) → teamId
    private static final Map<String, Integer> ID_BY_CODE = new HashMap<>();
    static {
        for (int i = 1; i < CODE_BY_ID.length; i++) ID_BY_CODE.put(CODE_BY_ID[i].toUpperCase(), i);
    }
    // 하이라이트 컬러 — 앱 getTeamBgColor(다크) 실효값과 동일:
    // colorBadgeOverride(KT) > luminance<0.05면 colorLight(두산/롯데/키움) > colorPrimary.
    private static final int[] HL_BY_ID = {
        0, 0xFFC60C30, 0xFF9BA8D4, 0xFFE85050, 0xFFCE0E2D, 0xFF315288,
        0xFFEA0029, 0xFF6BC4E8, 0xFF074CA1, 0xFFFF6600, 0xFFC97088,
    };

    // 다크 테마 토큰(globals.css .dark) — 강제 다크모드라 이 값 고정
    private static final int C_BG = 0xFF0A0A0B;            // --bg-primary
    private static final int C_TEXT = 0xFFF5F5F7;          // --text-primary
    private static final int C_TEXT_SECONDARY = 0xFFBCBCC1; // --text-secondary
    private static final int C_TEXT_TERTIARY = 0xFF8E8E93;  // 헤더(작은 화면에서 #636366은 묻혀 라이트 톤)
    private static final int C_HEADER_LINE = 0x14FFFFFF;   // --border(white 8%)
    private static final int C_ROW_LINE = 0x0AFFFFFF;      // border-border/30 ≈ white 4%

    @Override
    public void onUpdate(Context context, AppWidgetManager mgr, int[] appWidgetIds) {
        renderIds(context, mgr, appWidgetIds);

        // 캐시가 오래됐으면 백그라운드 fetch 후 재렌더 (BroadcastReceiver 수명 연장).
        // goAsync()는 실제 receiver 콜백에서만 유효 — 수동 갱신은 renderAllFromCache 사용.
        SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long age = System.currentTimeMillis() - p.getLong(KEY_UPDATED, 0);
        if (age > FRESH_MS) {
            final PendingResult pr = goAsync();
            fetchAsync(context.getApplicationContext(), pr);
        }
    }

    private static void renderIds(Context context, AppWidgetManager mgr, int[] appWidgetIds) {
        for (int id : appWidgetIds) {
            RemoteViews v = buildViews(context, mgr, id);
            v.setOnClickPendingIntent(R.id.widget_rank_root,
                WidgetTapMode.tapIntent(context, TeamRankWidget.class, id));
            mgr.updateAppWidget(id, v);
        }
    }

    @Override
    public void onAppWidgetOptionsChanged(Context context, AppWidgetManager mgr,
                                          int appWidgetId, Bundle newOptions) {
        RemoteViews v = buildViews(context, mgr, appWidgetId);
        v.setOnClickPendingIntent(R.id.widget_rank_root,
            WidgetTapMode.tapIntent(context, TeamRankWidget.class, appWidgetId));
        mgr.updateAppWidget(appWidgetId, v);
    }

    /** 배치된 모든 순위 위젯을 현재 캐시로 재렌더 (최애팀 변경 등) — fetch 없음.
     *  수동 갱신 경로 전용: 실제 receiver가 아니라 goAsync() 불가. */
    static void renderAllFromCache(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, TeamRankWidget.class));
        if (ids == null || ids.length == 0) return;
        renderIds(ctx, mgr, ids);
    }

    /** 최신 순위를 강제 재조회 후 재렌더 — 경기 종료 FCM(game_end) 수신 시 호출.
     *  위젯 미배치면 no-op. Service 컨텍스트라 자체 스레드로 fetch. */
    static void fetchAndRefresh(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, TeamRankWidget.class));
        if (ids == null || ids.length == 0) return;
        final Context app = ctx.getApplicationContext();
        new Thread(() -> {
            fetchAndStore(app);
            renderAllFromCache(app);
        }).start();
    }

    private static void fetchAsync(final Context app, final PendingResult pr) {
        new Thread(() -> {
            try {
                if (fetchAndStore(app)) renderAllFromCache(app);
            } finally {
                pr.finish();
            }
        }).start();
    }

    /** /api/standings GET → prefs 캐시. 성공 시 true. 실패는 조용히 무시(기존 캐시 유지). */
    static boolean fetchAndStore(Context ctx) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(API_URL).openConnection();
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
            JSONArray rows = new JSONObject(sb.toString()).optJSONArray("standings");
            if (rows == null || rows.length() == 0) return false;
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(KEY_ROWS, rows.toString())
                .putLong(KEY_UPDATED, System.currentTimeMillis())
                .apply();
            return true;
        } catch (Exception e) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    // ── 렌더 ─────────────────────────────────────────────────────────────

    private static RemoteViews buildViews(Context ctx, AppWidgetManager mgr, int widgetId) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_team_rank);
        JSONArray rows = null;
        try {
            String raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(KEY_ROWS, "");
            if (!raw.isEmpty()) rows = new JSONArray(raw);
        } catch (Exception ignored) { }

        if (rows == null || rows.length() == 0) {
            v.setViewVisibility(R.id.widget_rank_img, View.GONE);
            v.setViewVisibility(R.id.widget_rank_empty, View.VISIBLE);
            return v;
        }
        v.setViewVisibility(R.id.widget_rank_img, View.VISIBLE);
        v.setViewVisibility(R.id.widget_rank_empty, View.GONE);

        // 위젯 실크기(dp) — 세로 홈화면은 minWidth × maxHeight. 미보고 시 4x4 근사값.
        Bundle opt = mgr.getAppWidgetOptions(widgetId);
        int wDp = opt.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0);
        int hDp = opt.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0);
        if (wDp <= 0) wDp = 320;
        if (hDp <= 0) hDp = 360;
        wDp = Math.max(250, Math.min(wDp, 500));
        hDp = Math.max(240, Math.min(hDp, 600));

        String my = ctx.getSharedPreferences(GameScoreWidget.PREFS, Context.MODE_PRIVATE)
            .getString(GameScoreWidget.KEY_MY_TEAM, "");
        Integer myId = my == null ? null : ID_BY_CODE.get(my.toUpperCase());

        v.setImageViewBitmap(R.id.widget_rank_img,
            renderTable(ctx, rows, myId == null ? 0 : myId, wDp, hDp));
        return v;
    }

    /** 순위표 전체를 한 비트맵으로 렌더. 앱 순위표 다크 디자인과 동일 좌표계(dp).
     *  기준 폭 340dp — 그보다 좁으면 전체(컬럼/폰트/로고)를 비례 축소해 컬럼 겹침 방지. */
    static Bitmap renderTable(Context ctx, JSONArray rows, int myTeamId, int wDp, int hDp) {
        float d = ctx.getResources().getDisplayMetrics().density;
        // 비트맵 메모리 가드 — 픽셀 수가 과하면 밀도를 낮춰 렌더(위젯 비트맵 한도 보호)
        while (wDp * d * hDp * d > 1_800_000f && d > 1f) d -= 0.5f;
        int W = (int) (wDp * d), H = (int) (hDp * d);
        Bitmap bmp = Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(bmp);

        Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        fill.setColor(C_BG);
        cv.drawRoundRect(new RectF(0, 0, W, H), 16 * d, 16 * d, fill);

        float k = Math.min(1f, wDp / 340f);  // 좁은 위젯 비례 축소
        float u = d * k;                     // 스케일 적용 dp→px 단위
        float padH = 12 * u;
        float padV = 8 * d;
        float headerH = 24 * d;
        float rowH = (H - padV * 2 - headerH) / Math.max(1, rows.length());

        // 컬럼 X 좌표(dp): [# 22 | 팀 flex | 승 26 | 패 26 | 무 22 | 승률 42 | 차 32 | 연속 36]
        float xRank = padH + 11 * u;                    // 가운데 정렬 기준점
        float xTeam = padH + 22 * u + 6 * u;            // 좌측 정렬 시작점
        float xStreakR = W - padH;                      // 이하 우측 정렬 기준점
        float xGbR = xStreakR - 36 * u - 8 * u;
        float xPctR = xGbR - 32 * u - 8 * u;
        float xDrawR = xPctR - 42 * u - 8 * u;
        float xLossR = xDrawR - 22 * u - 8 * u;
        float xWinR = xLossR - 26 * u - 8 * u;

        Typeface mont = font(ctx, R.font.montserrat_vf, Typeface.DEFAULT_BOLD);
        Typeface noto = font(ctx, R.font.notosanskr_vf, Typeface.DEFAULT);

        // 헤더 — 앱 thead(text-sm, semibold, tertiary)
        float hs = 12.5f * u;
        float hBase = padV + headerH / 2 + textCenterOffset(hs);
        drawMixed(cv, "#", xRank, hBase, hs, C_TEXT_TERTIARY, ALIGN_CENTER, mont, noto);
        drawMixed(cv, "팀", xTeam, hBase, hs, C_TEXT_TERTIARY, ALIGN_LEFT, mont, noto);
        drawMixed(cv, "승", xWinR, hBase, hs, C_TEXT_TERTIARY, ALIGN_RIGHT, mont, noto);
        drawMixed(cv, "패", xLossR, hBase, hs, C_TEXT_TERTIARY, ALIGN_RIGHT, mont, noto);
        drawMixed(cv, "무", xDrawR, hBase, hs, C_TEXT_TERTIARY, ALIGN_RIGHT, mont, noto);
        drawMixed(cv, "승률", xPctR, hBase, hs, C_TEXT_TERTIARY, ALIGN_RIGHT, mont, noto);
        drawMixed(cv, "차", xGbR, hBase, hs, C_TEXT_TERTIARY, ALIGN_RIGHT, mont, noto);
        drawMixed(cv, "연속", xStreakR, hBase, hs, C_TEXT_TERTIARY, ALIGN_RIGHT, mont, noto);

        Paint line = new Paint();
        line.setColor(C_HEADER_LINE);
        cv.drawRect(padH, padV + headerH - d, W - padH, padV + headerH, line);

        float fs = Math.min(13.5f * u, rowH / 1.25f);   // 본문 text-sm~base, 행 높이 상한(4x3 등 낮은 높이서 세로 겹침 방지)
        float logo = Math.min(20 * u, rowH - 6 * d);
        for (int i = 0; i < rows.length(); i++) {
            JSONObject s = rows.optJSONObject(i);
            if (s == null) continue;
            float top = padV + headerH + rowH * i;
            float base = top + rowH / 2 + textCenterOffset(fs);
            int teamId = s.optInt("teamId", 0);
            String code = teamId >= 1 && teamId <= 10 ? CODE_BY_ID[teamId] : "";

            // 최애팀 하이라이트 — 앱과 동일(bg 팀컬러 α0x18 + 좌측 3dp 바)
            if (teamId != 0 && teamId == myTeamId) {
                int hl = HL_BY_ID[teamId];
                fill.setColor((hl & 0x00FFFFFF) | 0x18000000);
                cv.drawRect(0, top, W, top + rowH, fill);
                fill.setColor(hl);
                cv.drawRect(0, top, 3 * d, top + rowH, fill);
            }

            // 행 구분선(마지막 행 제외) — border-border/30
            if (i < rows.length() - 1) {
                line.setColor(C_ROW_LINE);
                cv.drawRect(padH, top + rowH - d, W - padH, top + rowH, line);
            }

            drawMixed(cv, String.valueOf(s.optInt("ranking", i + 1)),
                xRank, base, fs, C_TEXT, ALIGN_CENTER, mont, noto);

            // 팀 로고 + 약어
            float tx = xTeam;
            int logoRes = code.isEmpty() ? 0 : ctx.getResources()
                .getIdentifier("teamlogo_" + code, "drawable", ctx.getPackageName());
            if (logoRes != 0) {
                Drawable dr = ContextCompat.getDrawable(ctx, logoRes);
                if (dr != null) {
                    int ly = (int) (top + (rowH - logo) / 2);
                    dr.setBounds((int) tx, ly, (int) (tx + logo), (int) (ly + logo));
                    dr.draw(cv);
                    tx += logo + 5 * u;
                }
            }
            drawMixed(cv, s.optString("teamName", ""), tx, base, fs, C_TEXT, ALIGN_LEFT, mont, noto);

            drawMixed(cv, String.valueOf(s.optInt("wins", 0)), xWinR, base, fs, C_TEXT, ALIGN_RIGHT, mont, noto);
            drawMixed(cv, String.valueOf(s.optInt("losses", 0)), xLossR, base, fs, C_TEXT, ALIGN_RIGHT, mont, noto);
            drawMixed(cv, String.valueOf(s.optInt("draws", 0)), xDrawR, base, fs, C_TEXT_SECONDARY, ALIGN_RIGHT, mont, noto);
            drawMixed(cv, pctLabel(s.optDouble("winRate", 0)), xPctR, base, fs, C_TEXT, ALIGN_RIGHT, mont, noto, true);
            drawMixed(cv, gbLabel(s.optDouble("gamesBehind", 0)), xGbR, base, fs, C_TEXT_SECONDARY, ALIGN_RIGHT, mont, noto);
            String streak = s.optString("continuousGameResult", "").trim();
            drawMixed(cv, streak.isEmpty() ? "-" : streak, xStreakR, base, fs,
                streak.isEmpty() ? C_TEXT_SECONDARY : C_TEXT, ALIGN_RIGHT, mont, noto);
        }
        return bmp;
    }

    /** 앱 표기와 동일: 승률 ".622"(1 이상이면 "1.000"). */
    private static String pctLabel(double pct) {
        if (pct >= 1) return "1.000";
        String s = String.format(java.util.Locale.US, "%.3f", pct);
        return s.substring(1);
    }

    /** 앱 표기와 동일: 게임차 0 → "-", 정수는 소수점 없이, 그 외 한 자리("6.5"). */
    private static String gbLabel(double gb) {
        if (gb == 0) return "-";
        if (gb == Math.floor(gb)) return String.valueOf((long) gb);
        return String.format(java.util.Locale.US, "%.1f", gb);
    }

    private static Typeface font(Context ctx, int res, Typeface fallback) {
        try {
            Typeface t = ResourcesCompat.getFont(ctx, res);
            return t != null ? t : fallback;
        } catch (Exception e) {
            return fallback;
        }
    }

    /** 수직 중앙 정렬용 baseline 보정값(대략 cap-height 기준). */
    private static float textCenterOffset(float textSizePx) {
        return textSizePx * 0.36f;
    }

    private static final int ALIGN_LEFT = 0;
    private static final int ALIGN_RIGHT = 1;
    private static final int ALIGN_CENTER = 2;

    private static void drawMixed(Canvas cv, String text, float x, float baseline,
                                  float sizePx, int color, int align, Typeface mont, Typeface noto) {
        drawMixed(cv, text, x, baseline, sizePx, color, align, mont, noto, false);
    }

    /** 혼합 텍스트를 캔버스에 직접 렌더 — 숫자/영문=Montserrat, 한글=Noto Sans KR.
     *  GameScoreWidget.textBitmap과 동일 규칙(비트맵 대신 캔버스 직행). */
    private static void drawMixed(Canvas cv, String text, float x, float baseline,
                                  float sizePx, int color, int align,
                                  Typeface mont, Typeface noto, boolean bold) {
        if (text == null || text.isEmpty()) return;
        Paint pm = new Paint(Paint.ANTI_ALIAS_FLAG);
        pm.setTypeface(mont); pm.setTextSize(sizePx); pm.setColor(color);
        pm.setLetterSpacing(-0.02f); pm.setSubpixelText(true);
        Paint pn = new Paint(Paint.ANTI_ALIAS_FLAG);
        pn.setTypeface(noto); pn.setTextSize(sizePx); pn.setColor(color);
        pn.setLetterSpacing(-0.04f); pn.setSubpixelText(true);
        if (bold) { pm.setFakeBoldText(true); pn.setFakeBoldText(true); }

        // 한글/비한글 런 분할 후 폭 합산 → 정렬 기준으로 시작 x 결정
        java.util.List<String> runs = new java.util.ArrayList<>();
        java.util.List<Boolean> hangul = new java.util.ArrayList<>();
        StringBuilder cur = new StringBuilder();
        boolean curH = false;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            boolean h = (c >= 0xAC00 && c <= 0xD7A3) || (c >= 0x1100 && c <= 0x11FF)
                || (c >= 0x3130 && c <= 0x318F);
            if (cur.length() > 0 && h != curH) {
                runs.add(cur.toString()); hangul.add(curH); cur.setLength(0);
            }
            cur.append(c); curH = h;
        }
        if (cur.length() > 0) { runs.add(cur.toString()); hangul.add(curH); }

        float w = 0;
        for (int i = 0; i < runs.size(); i++) w += (hangul.get(i) ? pn : pm).measureText(runs.get(i));
        float sx = align == ALIGN_RIGHT ? x - w : align == ALIGN_CENTER ? x - w / 2 : x;
        for (int i = 0; i < runs.size(); i++) {
            Paint p = hangul.get(i) ? pn : pm;
            cv.drawText(runs.get(i), sx, baseline, p);
            sx += p.measureText(runs.get(i));
        }
    }
}
