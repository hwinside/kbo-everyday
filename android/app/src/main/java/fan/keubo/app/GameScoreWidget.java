package fan.keubo.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.text.TextUtils;
import android.view.View;
import android.widget.RemoteViews;

import androidx.core.content.res.ResourcesCompat;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 홈/잠금화면 App Widget — iOS MY TEAM 카드(IMG_6990)와 동일, BSO 제외.
 * 배경=최애팀 컬러 그라데이션 + 반투명 로고 워터마크, 양팀 로고/약어/점수,
 * LIVE 이닝 pill, 투수/타자, 베이스 다이아몬드.
 *
 * 데이터는 SharedPreferences(kbo_game_widget)에 구조화 저장:
 *  - 앱 포그라운드(경기룸): 풀 데이터(주자/투수/타자 포함) — JS가 updateWidget으로 기록.
 *  - 앱 종료 상태: FCM data 푸시(game_live) — KboMessagingService가 팀/점수/이닝 기록.
 * 값이 없으면 빈 상태("경기 정보가 없어요")로 가짜 스코어 노출 방지.
 *
 * 팀 코드 = KBO 2자 코드(gameId에서 파싱): LG/OB/KT/SK/NC/HT/LT/SS/HH/WO.
 */
public class GameScoreWidget extends AppWidgetProvider {

    static final String PREFS = "kbo_game_widget";
    static final String KEY_HAS_GAME = "has_game";
    static final String KEY_MY_TEAM = "my_team";
    static final String KEY_AWAY = "away";
    static final String KEY_HOME = "home";
    static final String KEY_AS = "as";
    static final String KEY_HS = "hs";
    static final String KEY_STATUS = "status";
    static final String KEY_PITCHER = "pitcher";
    static final String KEY_PTEAM = "pteam";
    static final String KEY_BATTER = "batter";
    static final String KEY_BTEAM = "bteam";
    static final String KEY_OUTS = "outs";
    static final String KEY_DIAMOND = "diamond";
    static final String KEY_STADIUM = "stadium"; // 경기장명(잠실 등) — 점수 위 별도 표시
    static final String KEY_ASTARTER = "astarter"; // 예고선발(원정) — 예정 경기에서만
    static final String KEY_HSTARTER = "hstarter"; // 예고선발(홈)
    // legacy(알림 호환) — 위젯 렌더에는 미사용
    static final String KEY_TITLE = "title";
    static final String KEY_SUB = "sub";

    // KBO 2자 코드 → 팀명
    private static final Map<String, String> SHORT = new HashMap<>();
    private static final Map<String, String> FULL = new HashMap<>();
    static {
        SHORT.put("LG", "LG"); SHORT.put("OB", "두산"); SHORT.put("KT", "KT");
        SHORT.put("SK", "SSG"); SHORT.put("NC", "NC"); SHORT.put("HT", "KIA");
        SHORT.put("LT", "롯데"); SHORT.put("SS", "삼성"); SHORT.put("HH", "한화");
        SHORT.put("WO", "키움");

        FULL.put("LG", "LG 트윈스"); FULL.put("OB", "두산 베어스"); FULL.put("KT", "KT 위즈");
        FULL.put("SK", "SSG 랜더스"); FULL.put("NC", "NC 다이노스"); FULL.put("HT", "KIA 타이거즈");
        FULL.put("LT", "롯데 자이언츠"); FULL.put("SS", "삼성 라이온즈"); FULL.put("HH", "한화 이글스");
        FULL.put("WO", "키움 히어로즈");
    }

    private static String shortName(String code) {
        if (code == null) return "";
        String s = SHORT.get(code.toUpperCase());
        return s != null ? s : code.toUpperCase();
    }

    private static String fullName(String code) {
        if (code == null) return "";
        String s = FULL.get(code.toUpperCase());
        return s != null ? s : shortName(code);
    }

    /** 예고선발 표시 라벨 — "선발 {이름}", 미확정(빈값)이면 "선발 미정". */
    private static String starterLabel(String name) {
        String n = name == null ? "" : name.trim();
        return "선발 " + (n.isEmpty() ? "미정" : n);
    }

    /** drawable 리소스 id 해석 (없으면 0). drawable-nodpi PNG도 "drawable" 타입. */
    private static int draw(Context ctx, String name) {
        return ctx.getResources().getIdentifier(name, "drawable", ctx.getPackageName());
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager mgr, int[] appWidgetIds) {
        // 카드 탭 → 앱 실행 (딥링크는 알림 카드가 담당, 위젯은 앱 홈)
        Intent launch = context.getPackageManager()
            .getLaunchIntentForPackage(context.getPackageName());
        PendingIntent pi = PendingIntent.getActivity(
            context, 0, launch,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        for (int id : appWidgetIds) {
            RemoteViews v = buildCard(context);
            v.setOnClickPendingIntent(R.id.widget_root, pi);
            mgr.updateAppWidget(id, v);
        }
    }

    /** 현재 prefs로 카드 RemoteViews 생성 — 위젯 + 잠금화면 알림 카드 공용.
     *  경기 없으면 빈 상태("경기 정보가 없어요"). */
    static RemoteViews buildCard(Context context) {
        SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        boolean hasGame = p.getBoolean(KEY_HAS_GAME, false);

        String myTeam = p.getString(KEY_MY_TEAM, "");
        String away = p.getString(KEY_AWAY, "");
        String home = p.getString(KEY_HOME, "");
        String as = p.getString(KEY_AS, "0");
        String hs = p.getString(KEY_HS, "0");
        String status = p.getString(KEY_STATUS, "");
        String pitcher = p.getString(KEY_PITCHER, "");
        String pteam = p.getString(KEY_PTEAM, "");
        String batter = p.getString(KEY_BATTER, "");
        String bteam = p.getString(KEY_BTEAM, "");
        String outs = p.getString(KEY_OUTS, "");
        String diamond = p.getString(KEY_DIAMOND, "000");
        String stadium = p.getString(KEY_STADIUM, "");
        String astarter = p.getString(KEY_ASTARTER, "");
        String hstarter = p.getString(KEY_HSTARTER, "");

        RemoteViews v = new RemoteViews(context.getPackageName(), R.layout.widget_game_score);

        if (!hasGame || away.isEmpty() || home.isEmpty()) {
            // 빈 상태
            v.setViewVisibility(R.id.widget_content, View.GONE);
            v.setViewVisibility(R.id.widget_empty, View.VISIBLE);
            v.setViewVisibility(R.id.widget_wm, View.GONE);
            v.setInt(R.id.widget_root, "setBackgroundResource", R.drawable.widget_bg_lg);
            return v;
        }

        v.setViewVisibility(R.id.widget_content, View.VISIBLE);
        v.setViewVisibility(R.id.widget_empty, View.GONE);

        // 배경 = 최애팀 컬러(미설정 시 home 팀). 워터마크 동일 팀.
        String bgTeam = !myTeam.isEmpty() ? myTeam : home;
        int bgRes = draw(context, "widget_bg_" + bgTeam.toLowerCase());
        v.setInt(R.id.widget_root, "setBackgroundResource",
            bgRes != 0 ? bgRes : R.drawable.widget_bg_lg);
        int wmRes = draw(context, "widget_wm_" + bgTeam.toLowerCase());
        if (wmRes != 0) {
            v.setViewVisibility(R.id.widget_wm, View.VISIBLE);
            v.setImageViewResource(R.id.widget_wm, wmRes);
        } else {
            v.setViewVisibility(R.id.widget_wm, View.GONE);
        }

        // MY TEAM 헤더 로고 (최애팀 미설정 시 home 로고로 대체)
        int myLogo = draw(context, "teamlogo_" + bgTeam.toLowerCase());
        if (myLogo != 0) v.setImageViewResource(R.id.widget_myteam_logo, myLogo);
        // 모든 텍스트는 비트맵 렌더 — RemoteViews(런처 프로세스)가 커스텀 fontFamily를
        // 무시해 Montserrat이 시스템 폰트로 폴백되던 문제 회피(숫자/영문=Montserrat, 한글=Noto).
        v.setImageViewBitmap(R.id.widget_myteam_label, textBitmap(context, "MY TEAM", 13f, 0xFFE0506A));

        // 양팀 로고/약어/점수
        int awayLogo = draw(context, "teamlogo_" + away.toLowerCase());
        int homeLogo = draw(context, "teamlogo_" + home.toLowerCase());
        if (awayLogo != 0) v.setImageViewResource(R.id.widget_away_logo, awayLogo);
        if (homeLogo != 0) v.setImageViewResource(R.id.widget_home_logo, homeLogo);
        v.setImageViewBitmap(R.id.widget_away_name, textBitmap(context, fullName(away), 14f, 0xFFE8B0BC));
        v.setImageViewBitmap(R.id.widget_home_name, textBitmap(context, fullName(home), 14f, 0xFFE8B0BC));
        boolean isScheduled = status != null && status.startsWith("SCHEDULED|");
        boolean isFinal = status != null && status.startsWith("FINAL");
        // 예정 status = "SCHEDULED|<시간>|<날짜라벨>" (날짜라벨은 선택)
        String schedTime = "";
        String dateLabel = "";
        if (isScheduled) {
            String sched = status.substring("SCHEDULED|".length());
            int bar = sched.indexOf('|');
            schedTime = bar >= 0 ? sched.substring(0, bar) : sched;
            dateLabel = bar >= 0 ? sched.substring(bar + 1) : "";
        }
        if (isScheduled) {
            v.setViewVisibility(R.id.widget_score, View.GONE);
            v.setViewVisibility(R.id.widget_score_scheduled, View.VISIBLE);
            v.setTextViewText(R.id.widget_score_scheduled, "경기 예정");
        } else {
            // 라이브/종료 둘 다 점수 표시 (종료=결과). Montserrat 숫자 비트맵.
            v.setViewVisibility(R.id.widget_score, View.VISIBLE);
            v.setViewVisibility(R.id.widget_score_scheduled, View.GONE);
            v.setImageViewBitmap(R.id.widget_score, textBitmap(context, as + " : " + hs, 30f, 0xFFF5F5F7));
        }

        // 경기 날짜('6월 7일 (토)') — 예정 경기일 때만 경기장 위 표시. 숫자(Mont)+한글(Noto) 비트맵.
        if (dateLabel.isEmpty()) {
            v.setViewVisibility(R.id.widget_date, View.GONE);
        } else {
            v.setViewVisibility(R.id.widget_date, View.VISIBLE);
            v.setImageViewBitmap(R.id.widget_date, textBitmap(context, dateLabel, 12f, 0xFFC8C8CE));
        }

        // 경기장(잠실) — 가운데 점수 위 별도 표시 (한글이라 TextView 유지)
        if (stadium.isEmpty()) {
            v.setViewVisibility(R.id.widget_stadium, View.GONE);
        } else {
            v.setViewVisibility(R.id.widget_stadium, View.VISIBLE);
            v.setTextViewText(R.id.widget_stadium, stadium);
        }

        // 상태 pill — 라이브 "● LIVE N회초" 빨강 정적, 종료 "경기 종료", 예정은 시간. 혼합 비트맵.
        if (status.isEmpty() || "SCHEDULED|".equals(status)) {
            v.setViewVisibility(R.id.widget_status, View.GONE);
        } else {
            v.setViewVisibility(R.id.widget_status, View.VISIBLE);
            String pill = isScheduled ? schedTime : isFinal ? "경기 종료" : "● " + status;
            v.setImageViewBitmap(R.id.widget_status_img, textBitmap(context, pill, 12f, 0xFFFF6B7A));
        }

        // 예고선발 행 — 예정 경기에서만(양팀 예고선발, 미확정이면 "선발 미정"). 라이브/종료는 숨김.
        // 혼합(한글+영문 이름) 대응 위해 textBitmap 렌더(RemoteViews 폰트 미적용 회피).
        if (isScheduled) {
            v.setViewVisibility(R.id.widget_starter_divider, View.VISIBLE);
            v.setViewVisibility(R.id.widget_starter_row, View.VISIBLE);
            v.setImageViewBitmap(R.id.widget_away_starter, textBitmap(context, starterLabel(astarter), 13f, 0xFFEDEDF0));
            v.setImageViewBitmap(R.id.widget_home_starter, textBitmap(context, starterLabel(hstarter), 13f, 0xFFEDEDF0));
        } else {
            v.setViewVisibility(R.id.widget_starter_divider, View.GONE);
            v.setViewVisibility(R.id.widget_starter_row, View.GONE);
        }

        // 하단: OUT + 투수/타자 소속표기 + 다이아몬드 (라이브 정보 없으면 행 숨김)
        int diaRes = draw(context, "diamond_" + diamond);
        boolean hasPitcher = !TextUtils.isEmpty(pitcher);
        boolean hasBatter = !TextUtils.isEmpty(batter);
        boolean hasOuts = !TextUtils.isEmpty(outs);
        boolean hasLive = hasPitcher || hasBatter || hasOuts || !"000".equals(diamond);
        if (hasLive) {
            v.setViewVisibility(R.id.widget_live_row, View.VISIBLE);

            // OUT 카운트 (B/S 제거, 아웃만)
            int outRes = hasOuts ? draw(context, "out_" + outs) : 0;
            if (outRes != 0) {
                v.setViewVisibility(R.id.widget_out, View.VISIBLE);
                v.setImageViewResource(R.id.widget_out, outRes);
            } else {
                v.setViewVisibility(R.id.widget_out, View.GONE);
            }

            // 투수 (소속) 이름
            if (hasPitcher) {
                v.setViewVisibility(R.id.widget_pitcher_row, View.VISIBLE);
                String pl = pteam.isEmpty() ? "투수" : "투수 (" + shortName(pteam) + ")";
                v.setTextViewText(R.id.widget_pitcher_label, pl);
                v.setTextViewText(R.id.widget_pitcher_name, pitcher);
            } else {
                v.setViewVisibility(R.id.widget_pitcher_row, View.GONE);
            }

            // 타자 (소속) 이름
            if (hasBatter) {
                v.setViewVisibility(R.id.widget_batter_row, View.VISIBLE);
                String bl = bteam.isEmpty() ? "타자" : "타자 (" + shortName(bteam) + ")";
                v.setTextViewText(R.id.widget_batter_label, bl);
                v.setTextViewText(R.id.widget_batter_name, batter);
            } else {
                v.setViewVisibility(R.id.widget_batter_row, View.GONE);
            }

            if (diaRes != 0) v.setImageViewResource(R.id.widget_diamond, diaRes);
        } else {
            v.setViewVisibility(R.id.widget_live_row, View.GONE);
        }

        return v;
    }

    /** 스몰(2x2) 위젯 카드 — iOS systemSmall(HomeWidgetSmallCard) 등가. 같은 prefs 공유, 렌더만 컴팩트.
     *  가운데=라이브/종료 점수 or 예정 VS, 하단 pill=LIVE 이닝/경기 종료/시각. 경기 없으면 빈 상태. */
    static RemoteViews buildSmallCard(Context context) {
        SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        boolean hasGame = p.getBoolean(KEY_HAS_GAME, false);
        String myTeam = p.getString(KEY_MY_TEAM, "");
        String away = p.getString(KEY_AWAY, "");
        String home = p.getString(KEY_HOME, "");
        String as = p.getString(KEY_AS, "0");
        String hs = p.getString(KEY_HS, "0");
        String status = p.getString(KEY_STATUS, "");

        RemoteViews v = new RemoteViews(context.getPackageName(), R.layout.widget_game_score_small);

        if (!hasGame || away.isEmpty() || home.isEmpty()) {
            v.setViewVisibility(R.id.widget_small_content, View.GONE);
            v.setViewVisibility(R.id.widget_small_empty, View.VISIBLE);
            v.setViewVisibility(R.id.widget_small_wm, View.GONE);
            v.setInt(R.id.widget_small_root, "setBackgroundResource", R.drawable.widget_bg_lg);
            return v;
        }
        v.setViewVisibility(R.id.widget_small_content, View.VISIBLE);
        v.setViewVisibility(R.id.widget_small_empty, View.GONE);

        String bgTeam = !myTeam.isEmpty() ? myTeam : home;
        int bgRes = draw(context, "widget_bg_" + bgTeam.toLowerCase());
        v.setInt(R.id.widget_small_root, "setBackgroundResource", bgRes != 0 ? bgRes : R.drawable.widget_bg_lg);
        int wmRes = draw(context, "widget_wm_" + bgTeam.toLowerCase());
        if (wmRes != 0) {
            v.setViewVisibility(R.id.widget_small_wm, View.VISIBLE);
            v.setImageViewResource(R.id.widget_small_wm, wmRes);
        } else {
            v.setViewVisibility(R.id.widget_small_wm, View.GONE);
        }

        int myLogo = draw(context, "teamlogo_" + bgTeam.toLowerCase());
        if (myLogo != 0) v.setImageViewResource(R.id.widget_small_myteam_logo, myLogo);
        v.setImageViewBitmap(R.id.widget_small_myteam_label, textBitmap(context, "MY TEAM", 11f, 0xFFE0506A));

        int awayLogo = draw(context, "teamlogo_" + away.toLowerCase());
        int homeLogo = draw(context, "teamlogo_" + home.toLowerCase());
        if (awayLogo != 0) v.setImageViewResource(R.id.widget_small_away_logo, awayLogo);
        if (homeLogo != 0) v.setImageViewResource(R.id.widget_small_home_logo, homeLogo);

        boolean isScheduled = status != null && status.startsWith("SCHEDULED|");
        boolean isFinal = status != null && status.startsWith("FINAL");
        String schedTime = "";
        if (isScheduled) {
            String sched = status.substring("SCHEDULED|".length());
            int bar = sched.indexOf('|');
            schedTime = bar >= 0 ? sched.substring(0, bar) : sched;
        }
        // 가운데: 라이브/종료=점수(Mont), 예정=VS
        if (isScheduled) {
            v.setImageViewBitmap(R.id.widget_small_vs, textBitmap(context, "VS", 15f, 0xB3FFFFFF));
        } else {
            v.setImageViewBitmap(R.id.widget_small_vs, textBitmap(context, as + " : " + hs, 22f, 0xFFF5F5F7));
        }
        // 상태 pill
        if (status.isEmpty() || "SCHEDULED|".equals(status)) {
            v.setViewVisibility(R.id.widget_small_status, View.GONE);
        } else {
            v.setViewVisibility(R.id.widget_small_status, View.VISIBLE);
            String pill = isScheduled ? schedTime : isFinal ? "경기 종료" : "● " + status;
            v.setImageViewBitmap(R.id.widget_small_status_img, textBitmap(context, pill, 11f, 0xFFFF6B7A));
        }
        return v;
    }

    // ── 텍스트 비트맵 렌더 ──────────────────────────────────────────────
    // RemoteViews(홈 위젯)는 런처 프로세스에서 inflate되며 커스텀 fontFamily를 무시한다
    // (삼성 런처 등). 그래서 Montserrat이 시스템 폰트로 폴백돼 안 보였다. 텍스트를 Paint로
    // 직접 비트맵에 그려 ImageView에 넣으면 런처 무관하게 폰트가 확실히 적용된다.
    // 분류: 한글 = Noto Sans KR(600), 그 외(숫자/영문/기호) = Montserrat(700).
    private static Typeface tfMont, tfNoto;

    private static Typeface mont(Context c) {
        if (tfMont == null) {
            Typeface t = ResourcesCompat.getFont(c, R.font.montserrat_vf);
            tfMont = t != null ? t : Typeface.DEFAULT_BOLD;
        }
        return tfMont;
    }

    private static Typeface noto(Context c) {
        if (tfNoto == null) {
            Typeface t = ResourcesCompat.getFont(c, R.font.notosanskr_vf);
            tfNoto = t != null ? t : Typeface.DEFAULT;
        }
        return tfNoto;
    }

    private static boolean isHangul(char c) {
        return (c >= 0xAC00 && c <= 0xD7A3)   // 음절
            || (c >= 0x1100 && c <= 0x11FF)   // 자모
            || (c >= 0x3130 && c <= 0x318F);  // 호환 자모
    }

    /** 혼합 텍스트(숫자/영문=Montserrat, 한글=Noto)를 한 비트맵으로 렌더. spSize는 dp 환산. */
    private static Bitmap textBitmap(Context ctx, String text, float spSize, int color) {
        if (text == null) text = "";
        float density = ctx.getResources().getDisplayMetrics().density;
        float px = spSize * density;
        Paint pm = new Paint(Paint.ANTI_ALIAS_FLAG);
        pm.setTypeface(mont(ctx)); pm.setTextSize(px); pm.setColor(color);
        pm.setLetterSpacing(-0.02f); pm.setSubpixelText(true);
        Paint pn = new Paint(Paint.ANTI_ALIAS_FLAG);
        pn.setTypeface(noto(ctx)); pn.setTextSize(px); pn.setColor(color);
        pn.setLetterSpacing(-0.04f); pn.setSubpixelText(true);

        // 한글/비한글 런으로 분할
        List<String> runs = new ArrayList<>();
        List<Boolean> runHangul = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        boolean curH = false;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            boolean h = isHangul(c);
            if (cur.length() > 0 && h != curH) { runs.add(cur.toString()); runHangul.add(curH); cur.setLength(0); }
            cur.append(c); curH = h;
        }
        if (cur.length() > 0) { runs.add(cur.toString()); runHangul.add(curH); }

        float w = 0;
        for (int i = 0; i < runs.size(); i++) w += (runHangul.get(i) ? pn : pm).measureText(runs.get(i));
        Paint.FontMetrics fm = pm.getFontMetrics();
        Paint.FontMetrics fn = pn.getFontMetrics();
        float top = Math.min(fm.top, fn.top);
        float bottom = Math.max(fm.bottom, fn.bottom);
        int bw = Math.max(1, (int) Math.ceil(w) + 2);
        int bh = Math.max(1, (int) Math.ceil(bottom - top) + 2);
        Bitmap bmp = Bitmap.createBitmap(bw, bh, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(bmp);
        float x = 1f;
        float baseline = -top + 1f;
        for (int i = 0; i < runs.size(); i++) {
            Paint p = runHangul.get(i) ? pn : pm;
            cv.drawText(runs.get(i), x, baseline, p);
            x += p.measureText(runs.get(i));
        }
        return bmp;
    }

    /** 상태 pill 텍스트를 영문/숫자(main=Montserrat)와 한글(suf=Noto Sans KR)로 분리해 두 TextView에 세팅.
     *  (notif 컴팩트 카드 전용 — 홈 위젯은 textBitmap 사용.) */
    private static void setStatusPill(RemoteViews v, int mainId, int sufId, String text) {
        if (text == null) text = "";
        int idx = -1;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c >= '가' && c <= '힣') { idx = i; break; }
        }
        String main = (idx < 0 ? text : text.substring(0, idx)).trim();
        String suf = (idx < 0 ? "" : text.substring(idx)).trim();
        v.setTextViewText(mainId, main);
        v.setTextViewText(sufId, suf);
        v.setViewVisibility(sufId, suf.isEmpty() ? View.GONE : View.VISIBLE);
        v.setViewVisibility(mainId, main.isEmpty() ? View.GONE : View.VISIBLE);
    }

    /** 알림 접힌 뷰용 컴팩트 카드(점수 한 줄). 경기 없으면 null. */
    static RemoteViews buildCompactCard(Context context) {
        SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String away = p.getString(KEY_AWAY, "");
        String home = p.getString(KEY_HOME, "");
        if (!p.getBoolean(KEY_HAS_GAME, false) || away.isEmpty() || home.isEmpty()) return null;

        String myTeam = p.getString(KEY_MY_TEAM, "");
        String bgTeam = !myTeam.isEmpty() ? myTeam : home;
        RemoteViews v = new RemoteViews(context.getPackageName(), R.layout.notif_card_compact);
        int bgRes = draw(context, "widget_bg_" + bgTeam.toLowerCase());
        v.setInt(R.id.ncc_root, "setBackgroundResource", bgRes != 0 ? bgRes : R.drawable.widget_bg_lg);

        int awayLogo = draw(context, "teamlogo_" + away.toLowerCase());
        int homeLogo = draw(context, "teamlogo_" + home.toLowerCase());
        if (awayLogo != 0) v.setImageViewResource(R.id.ncc_away_logo, awayLogo);
        if (homeLogo != 0) v.setImageViewResource(R.id.ncc_home_logo, homeLogo);
        v.setTextViewText(R.id.ncc_away_name, shortName(away));
        v.setTextViewText(R.id.ncc_home_name, shortName(home));
        String status = p.getString(KEY_STATUS, "");
        boolean isScheduled = status != null && status.startsWith("SCHEDULED|");
        if (isScheduled) {
            v.setViewVisibility(R.id.ncc_score, View.GONE);
            v.setViewVisibility(R.id.ncc_score_scheduled, View.VISIBLE);
            v.setTextViewText(R.id.ncc_score_scheduled, "경기 예정");
        } else {
            v.setViewVisibility(R.id.ncc_score, View.VISIBLE);
            v.setViewVisibility(R.id.ncc_score_scheduled, View.GONE);
            v.setTextViewText(R.id.ncc_score, p.getString(KEY_AS, "0") + " : " + p.getString(KEY_HS, "0"));
        }

        if (status.isEmpty()) {
            v.setViewVisibility(R.id.ncc_status, View.GONE);
        } else {
            v.setViewVisibility(R.id.ncc_status, View.VISIBLE);
            setStatusPill(v, R.id.ncc_status_main, R.id.ncc_status_suf, isScheduled
                ? status.substring("SCHEDULED|".length())
                : status);
        }
        return v;
    }

    /** 현재 경기 데이터가 있는지 (알림 카드 게시 여부 판단용). */
    static boolean hasGame(Context context) {
        SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return p.getBoolean(KEY_HAS_GAME, false)
            && !p.getString(KEY_AWAY, "").isEmpty()
            && !p.getString(KEY_HOME, "").isEmpty();
    }

    /** 구조화 데이터 기록 후 배치된 위젯 즉시 갱신.
     *  myTeam==null/빈값 → 기존 최애팀 값 유지(푸시는 디바이스 최애팀을 모름). */
    static void writeAndRefresh(Context ctx, String myTeam, String away, String home,
                                String as, String hs, String status, String pitcher, String pteam,
                                String batter, String bteam, String outs, String diamond,
                                String stadium, String astarter, String hstarter) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        SharedPreferences.Editor e = p.edit();
        e.putBoolean(KEY_HAS_GAME, true);
        e.putString(KEY_STADIUM, stadium == null ? "" : stadium);
        e.putString(KEY_ASTARTER, astarter == null ? "" : astarter);
        e.putString(KEY_HSTARTER, hstarter == null ? "" : hstarter);
        if (myTeam != null && !myTeam.isEmpty()) e.putString(KEY_MY_TEAM, myTeam);
        e.putString(KEY_AWAY, away == null ? "" : away);
        e.putString(KEY_HOME, home == null ? "" : home);
        e.putString(KEY_AS, as == null ? "0" : as);
        e.putString(KEY_HS, hs == null ? "0" : hs);
        e.putString(KEY_STATUS, status == null ? "" : status);
        e.putString(KEY_PITCHER, pitcher == null ? "" : pitcher);
        e.putString(KEY_PTEAM, pteam == null ? "" : pteam);
        e.putString(KEY_BATTER, batter == null ? "" : batter);
        e.putString(KEY_BTEAM, bteam == null ? "" : bteam);
        e.putString(KEY_OUTS, outs == null ? "" : outs);
        e.putString(KEY_DIAMOND, (diamond == null || diamond.isEmpty()) ? "000" : diamond);
        e.apply();
        refresh(ctx);
    }

    /** 빈 상태로 전환 (경기 종료/이탈). 최애팀 값은 유지. */
    static void clear(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        p.edit().putBoolean(KEY_HAS_GAME, false).apply();
        refresh(ctx);
    }

    /** 디바이스 최애팀 코드 기록(앱이 알 때). 위젯 배경/워터마크/헤더 색 결정. */
    static void setMyTeam(Context ctx, String code) {
        if (code == null) return;
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(KEY_MY_TEAM, code).apply();
        refresh(ctx);
    }

    /** 현재 prefs로 배치된 모든 위젯 재렌더 (미디엄 4x2 + 스몰 2x2 둘 다). */
    static void refresh(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, GameScoreWidget.class));
        if (ids != null && ids.length > 0) {
            new GameScoreWidget().onUpdate(ctx, mgr, ids);
        }
        int[] smallIds = mgr.getAppWidgetIds(new ComponentName(ctx, GameScoreWidgetSmall.class));
        if (smallIds != null && smallIds.length > 0) {
            new GameScoreWidgetSmall().onUpdate(ctx, mgr, smallIds);
        }
    }
}
