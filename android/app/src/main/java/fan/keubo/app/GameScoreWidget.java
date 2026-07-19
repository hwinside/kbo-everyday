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
    static final String KEY_LAST_PLAY = "last_play"; // 문자중계 최근 플레이 한 줄(라이브만)
    // gameId(YYYYMMDD… ) — 06:00 롤오버 기준일 계산용. 다음 예정 경기(next_*) 자동 전환.
    static final String KEY_GAME_ID = "game_id";
    static final String KEY_NEXT_HAS = "next_has";       // 다음 예정 경기 존재(결과/라이브일 때만)
    static final String KEY_NEXT_AWAY = "next_away";
    static final String KEY_NEXT_HOME = "next_home";
    static final String KEY_NEXT_STADIUM = "next_stadium";
    static final String KEY_NEXT_TIME = "next_time";     // "18:30"
    static final String KEY_NEXT_DATE = "next_date";     // "7월 5일 (일)"
    static final String KEY_NEXT_ASTARTER = "next_astarter";
    static final String KEY_NEXT_HSTARTER = "next_hstarter";
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

    // 승격 라이브 카드(GameNotificationPlugin.composeLiveCard)도 사용 — package-private.
    static String shortName(String code) {
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

    /** 승격(Live Update) 카드 largeIcon — 주자 다이아몬드(옐로우 채움) + 아웃카운트 도트(레드 채움) 패널.
     *  빈 요소는 테두리만(AOD 흑백 구분). diamond = 1·2·3루 점유 비트("101" = 1·3루), outs = "0"~"2".
     *  표준 템플릿은 자유 그래픽 불가라 아이콘 슬롯에 동적 비트맵으로 주입한다. */
    static Bitmap buildDiamondOutsIcon(String diamond, String outs) {
        int size = 192;
        Bitmap bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        String d = diamond == null || diamond.length() < 3 ? "000" : diamond;
        int outCount = 0;
        try {
            outCount = Math.min(Math.max(
                Integer.parseInt(outs == null || outs.isEmpty() ? "0" : outs), 0), 3);
        } catch (NumberFormatException ignored) { }

        int occupied = 0xFFFFD60A;  // 주자 = 옐로우 (7/18 00:49 색 스와프 확정)
        int outOn = 0xFFFF3B30;     // 아웃 = 레드
        int lineColor = 0xFF8A93A6; // 빈 요소 = 테두리만(AOD 흑백에서도 채움/테두리로 구분 — 삼순 조건)

        Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
        stroke.setStyle(Paint.Style.STROKE);
        stroke.setStrokeWidth(4f);
        stroke.setColor(lineColor);

        // 베이스 3개 — 다이아몬드형. centers[i] = {1루(right), 2루(top), 3루(left)} 순서로
        // d.charAt(0..2)=1루·2루·3루 점유 비트와 매칭. 점유=채움, 공백=테두리.
        float half = 26f;
        float[][] centers = { {146f, 84f}, {96f, 40f}, {46f, 84f} };
        for (int i = 0; i < 3; i++) {
            float cx = centers[i][0], cy = centers[i][1];
            android.graphics.Path path = new android.graphics.Path();
            path.moveTo(cx, cy - half);
            path.lineTo(cx + half, cy);
            path.lineTo(cx, cy + half);
            path.lineTo(cx - half, cy);
            path.close();
            if (d.charAt(i) == '1') {
                p.setColor(occupied);
                c.drawPath(path, p);
            } else {
                c.drawPath(path, stroke);
            }
        }
        // 아웃 도트 3개 — 아웃=채움, 나머지=테두리.
        float r = 11f, oy = 156f;
        float[] ox = { 62f, 96f, 130f };
        for (int i = 0; i < 3; i++) {
            if (i < outCount) {
                p.setColor(outOn);
                c.drawCircle(ox[i], oy, r, p);
            } else {
                c.drawCircle(ox[i], oy, r, stroke);
            }
        }
        return bmp;
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

    /** prefs에서 읽은 '유효' 위젯 상태 — 06:00 롤오버 적용 후 값. 세 렌더 경로 공용. */
    static class Eff {
        boolean hasGame;
        String myTeam = "", away = "", home = "", as = "0", hs = "0", status = "";
        String pitcher = "", pteam = "", batter = "", bteam = "", outs = "", diamond = "000";
        String stadium = "", astarter = "", hstarter = "";
        String lastPlay = "";
    }

    /** prefs 읽기 + 홈 팀카드 06:00 규칙 적용(경기일 다음날 06:00 지나면 다음 예정 경기로 전환).
     *  앱이 백그라운드라 prefs 재기록이 안 돼도 위젯이 스스로 '경기 예정'으로 넘어가게 한다. */
    static Eff readEff(Context context) {
        SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        Eff e = new Eff();
        e.hasGame = p.getBoolean(KEY_HAS_GAME, false);
        e.myTeam = p.getString(KEY_MY_TEAM, "");
        e.away = p.getString(KEY_AWAY, "");
        e.home = p.getString(KEY_HOME, "");
        e.as = p.getString(KEY_AS, "0");
        e.hs = p.getString(KEY_HS, "0");
        e.status = p.getString(KEY_STATUS, "");
        e.pitcher = p.getString(KEY_PITCHER, "");
        e.pteam = p.getString(KEY_PTEAM, "");
        e.batter = p.getString(KEY_BATTER, "");
        e.bteam = p.getString(KEY_BTEAM, "");
        e.outs = p.getString(KEY_OUTS, "");
        e.diamond = p.getString(KEY_DIAMOND, "000");
        e.stadium = p.getString(KEY_STADIUM, "");
        e.astarter = p.getString(KEY_ASTARTER, "");
        e.hstarter = p.getString(KEY_HSTARTER, "");
        e.lastPlay = p.getString(KEY_LAST_PLAY, "");

        // 상태 무관(예정 포함) — 경기일 다음날 06:00을 지났고 다음 예정 경기가 있으면 전환.
        // 미래 예정 경기(gameId가 미래)면 pastRollover=false라 그대로 유지된다.
        if (e.hasGame && p.getBoolean(KEY_NEXT_HAS, false)
                && pastRollover(p.getString(KEY_GAME_ID, ""))) {
            e.away = p.getString(KEY_NEXT_AWAY, e.away);
            e.home = p.getString(KEY_NEXT_HOME, e.home);
            e.as = "0"; e.hs = "0";
            e.stadium = p.getString(KEY_NEXT_STADIUM, "");
            e.astarter = p.getString(KEY_NEXT_ASTARTER, "");
            e.hstarter = p.getString(KEY_NEXT_HSTARTER, "");
            e.pitcher = ""; e.pteam = ""; e.batter = ""; e.bteam = ""; e.outs = ""; e.diamond = "000";
            e.status = "SCHEDULED|" + p.getString(KEY_NEXT_TIME, "") + "|" + p.getString(KEY_NEXT_DATE, "");
        }
        return e;
    }

    /** 결과 스냅샷을 다음 예정 경기로 넘길 시각(경기일 다음날 06:00 KST)을 지났는가. */
    static boolean pastRollover(String gameId) {
        if (gameId == null || gameId.length() < 8) return false;
        try {
            int y = Integer.parseInt(gameId.substring(0, 4));
            int mo = Integer.parseInt(gameId.substring(4, 6));
            int d = Integer.parseInt(gameId.substring(6, 8));
            java.util.Calendar cal =
                java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("Asia/Seoul"));
            cal.clear();
            cal.set(y, mo - 1, d, 6, 0, 0);
            cal.add(java.util.Calendar.DAY_OF_MONTH, 1); // 경기일 다음날 06:00
            return System.currentTimeMillis() >= cal.getTimeInMillis();
        } catch (NumberFormatException ex) {
            return false;
        }
    }

    /** 현재 prefs로 카드 RemoteViews 생성 — 홈 위젯용(widget_game_score).
     *  경기 없으면 빈 상태("경기 정보가 없어요"). */
    static RemoteViews buildCard(Context context) {
        return buildCard(context, R.layout.widget_game_score);
    }

    /** 잠금화면 알림 "펼친 뷰"용 풀카드 — 디자인 동일, 수직 여백만 축소한 클론 레이아웃.
     *  (One UI 알림 확장 높이 캡 안에 중계 틱커까지 온전히 표시) */
    static RemoteViews buildNotifFullCard(Context context) {
        return buildCard(context, R.layout.notif_card_full);
    }

    private static RemoteViews buildCard(Context context, int layoutRes) {
        Eff e = readEff(context);
        boolean hasGame = e.hasGame;
        String myTeam = e.myTeam;
        String away = e.away;
        String home = e.home;
        String as = e.as;
        String hs = e.hs;
        String status = e.status;
        String pitcher = e.pitcher;
        String pteam = e.pteam;
        String batter = e.batter;
        String bteam = e.bteam;
        String outs = e.outs;
        String diamond = e.diamond;
        String stadium = e.stadium;
        String astarter = e.astarter;
        String hstarter = e.hstarter;
        String lastPlay = e.lastPlay;

        RemoteViews v = new RemoteViews(context.getPackageName(), layoutRes);

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
        boolean isCancelled = "CANCELLED".equals(status);
        // 예정 status = "SCHEDULED|<시간>|<날짜라벨>" (날짜라벨은 선택)
        String schedTime = "";
        String dateLabel = "";
        if (isScheduled) {
            String sched = status.substring("SCHEDULED|".length());
            int bar = sched.indexOf('|');
            schedTime = bar >= 0 ? sched.substring(0, bar) : sched;
            dateLabel = bar >= 0 ? sched.substring(bar + 1) : "";
        }
        // 예정/취소는 점수 숨기고 가운데 문구(예정="경기 예정", 취소="경기 취소"). 라이브/종료는 점수.
        if (isScheduled || isCancelled) {
            v.setViewVisibility(R.id.widget_score, View.GONE);
            v.setViewVisibility(R.id.widget_score_scheduled, View.VISIBLE);
            v.setTextViewText(R.id.widget_score_scheduled, isCancelled ? "경기 취소" : "경기 예정");
        } else {
            // 라이브/종료 둘 다 점수 표시 (종료=결과). Montserrat 숫자 비트맵.
            v.setViewVisibility(R.id.widget_score, View.VISIBLE);
            v.setViewVisibility(R.id.widget_score_scheduled, View.GONE);
            v.setImageViewBitmap(R.id.widget_score, textBitmap(context, as + " : " + hs, 27f, 0xFFF5F5F7));
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
            String pill = isCancelled ? "경기 취소" : isScheduled ? schedTime : isFinal ? "경기 종료" : "● " + status;
            v.setImageViewBitmap(R.id.widget_status_img, textBitmap(context, pill, 12f, 0xFFFF6B7A));
        }

        // 예고선발 투수 이름 — 각 팀 풀네임 아래(예정 경기만, 미확정 "미정"). 라이브/종료는 숨김
        // (라이브/종료는 하단 live_row의 현재 투수/타자가 표시됨). TextView라 폰트 크기 고정.
        if (isScheduled) {
            String acol = astarter == null || astarter.trim().isEmpty() ? "미정" : astarter.trim();
            String hcol = hstarter == null || hstarter.trim().isEmpty() ? "미정" : hstarter.trim();
            v.setViewVisibility(R.id.widget_away_starter_col, View.VISIBLE);
            v.setViewVisibility(R.id.widget_home_starter_col, View.VISIBLE);
            v.setTextViewText(R.id.widget_away_starter_col, acol);
            v.setTextViewText(R.id.widget_home_starter_col, hcol);
        } else {
            v.setViewVisibility(R.id.widget_away_starter_col, View.GONE);
            v.setViewVisibility(R.id.widget_home_starter_col, View.GONE);
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

            // 투수/타자 한 줄 병합 — iOS 잠금 LA 카드(#557)와 동일. 두 줄이던 것을 합쳐
            // 4x2 셀(217dp)에 중계 줄까지 세로로 들어가게 한다(소속 표기는 공간상 생략).
            if (hasPitcher || hasBatter) {
                v.setViewVisibility(R.id.widget_pitcher_row, View.VISIBLE);
                v.setViewVisibility(R.id.widget_batter_row, View.GONE);
                StringBuilder line = new StringBuilder();
                if (hasPitcher) line.append(pitcher);
                if (hasBatter) {
                    if (hasPitcher) line.append(" · 타자 ");
                    line.append(batter);
                }
                v.setTextViewText(R.id.widget_pitcher_label, hasPitcher ? "투수" : "타자");
                v.setTextViewText(R.id.widget_pitcher_name, line.toString());
            } else {
                v.setViewVisibility(R.id.widget_pitcher_row, View.GONE);
                v.setViewVisibility(R.id.widget_batter_row, View.GONE);
            }

            if (diaRes != 0) v.setImageViewResource(R.id.widget_diamond, diaRes);
        } else {
            v.setViewVisibility(R.id.widget_live_row, View.GONE);
        }

        // 문자중계 최근 플레이 한 줄 — 라이브 + 텍스트 있을 때만. 그레이 틱커 바 + 라이브 점(●, 빨강 span).
        // 이닝은 상단 LIVE pill과 중복이라 서버 문구에서 제외(타자+결과만). iOS 잠금 LA 카드와 통일.
        boolean isLiveStatus = !isScheduled && !isFinal && !isCancelled && !status.isEmpty();
        if (isLiveStatus && !TextUtils.isEmpty(lastPlay)) {
            v.setViewVisibility(R.id.widget_relay_row, View.VISIBLE);
            // 라이브 점은 XML ViewFlipper(widget_relay_dot)가 자동 pulse — 서버 토글 아닌 클라 렌더.
            v.setTextViewText(R.id.widget_relay_text, lastPlay);
        } else {
            v.setViewVisibility(R.id.widget_relay_row, View.GONE);
        }

        return v;
    }

    /** 스몰(2x2) 위젯 카드 — iOS systemSmall(HomeWidgetSmallCard) 등가. 같은 prefs 공유, 렌더만 컴팩트.
     *  가운데=라이브/종료 점수 or 예정 VS, 하단 pill=LIVE 이닝/경기 종료/시각. 경기 없으면 빈 상태. */
    static RemoteViews buildSmallCard(Context context) {
        Eff e = readEff(context);
        boolean hasGame = e.hasGame;
        String myTeam = e.myTeam;
        String away = e.away;
        String home = e.home;
        String as = e.as;
        String hs = e.hs;
        String status = e.status;
        String astarter = e.astarter;
        String hstarter = e.hstarter;

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

        // 팀 약어 라벨(로고 밑) — 목업 기준 항상 표시
        v.setImageViewBitmap(R.id.widget_small_away_name, textBitmap(context, shortName(away), 13f, 0xFFF2F2F5));
        v.setImageViewBitmap(R.id.widget_small_home_name, textBitmap(context, shortName(home), 13f, 0xFFF2F2F5));

        boolean isScheduled = status != null && status.startsWith("SCHEDULED|");
        boolean isFinal = status != null && status.startsWith("FINAL");
        boolean isCancelled = "CANCELLED".equals(status);
        String schedTime = "";
        if (isScheduled) {
            String sched = status.substring("SCHEDULED|".length());
            int bar = sched.indexOf('|');
            schedTime = bar >= 0 ? sched.substring(0, bar) : sched;
        }
        // 가운데 VS는 항상 표시(취소는 ✕). 라이브/종료는 팀 약어 밑에 점수, 예정/취소는 점수 숨김.
        v.setImageViewBitmap(R.id.widget_small_vs, textBitmap(context, isCancelled ? "✕" : "VS", 14f, 0xB3FFFFFF));
        if (isScheduled || isCancelled) {
            v.setViewVisibility(R.id.widget_small_away_score, View.GONE);
            v.setViewVisibility(R.id.widget_small_home_score, View.GONE);
        } else {
            v.setViewVisibility(R.id.widget_small_away_score, View.VISIBLE);
            v.setViewVisibility(R.id.widget_small_home_score, View.VISIBLE);
            v.setImageViewBitmap(R.id.widget_small_away_score, textBitmap(context, as, 19f, 0xFFF5F5F7));
            v.setImageViewBitmap(R.id.widget_small_home_score, textBitmap(context, hs, 19f, 0xFFF5F5F7));
        }
        // 상태 pill — 예정 "{시각} 경기 예정", 라이브 "● {status}", 종료 "경기 종료"
        if (status.isEmpty() || "SCHEDULED|".equals(status)) {
            v.setViewVisibility(R.id.widget_small_status, View.GONE);
        } else {
            v.setViewVisibility(R.id.widget_small_status, View.VISIBLE);
            String pill = isCancelled ? "경기 취소" : isScheduled ? schedTime + " 경기 예정" : isFinal ? "경기 종료" : "● " + status;
            // TextView(비트맵 아님) — pill/선발/매치업 12sp 동일 렌더.
            v.setTextViewText(R.id.widget_small_status_img, pill);
        }
        // 예고선발 라인 — 예정 경기에서만("선발 {원정} vs {홈}", 미확정 "미정")
        if (isScheduled) {
            String a = astarter == null || astarter.trim().isEmpty() ? "미정" : astarter.trim();
            String h = hstarter == null || hstarter.trim().isEmpty() ? "미정" : hstarter.trim();
            v.setViewVisibility(R.id.widget_small_starter, View.VISIBLE);
            // 2줄 TextView(라벨 "선발"은 XML 정적) — pill/선발/매치업 폰트 13sp 동일, 색만 구분.
            // 비트맵 아님: 공간 부족 시 ImageView가 축소 렌더되던 문제 회피(크기 보장).
            v.setTextViewText(R.id.widget_small_starter_matchup, a + " vs " + h);
        } else {
            v.setViewVisibility(R.id.widget_small_starter, View.GONE);
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
        return textBitmap(ctx, text, spSize, color, false);
    }

    /** bold 오버로드 — setFakeBoldText는 글리프 두께만 키우고 폰트 실높이는 무변화라
     *  접힌 카드 높이 캡을 넘기지 않고 스코어 존재감을 키운다(2026-07-18 실측). */
    private static Bitmap textBitmap(Context ctx, String text, float spSize, int color, boolean bold) {
        if (text == null) text = "";
        float density = ctx.getResources().getDisplayMetrics().density;
        float px = spSize * density;
        Paint pm = new Paint(Paint.ANTI_ALIAS_FLAG);
        pm.setTypeface(mont(ctx)); pm.setTextSize(px); pm.setColor(color);
        pm.setLetterSpacing(-0.02f); pm.setSubpixelText(true); pm.setFakeBoldText(bold);
        Paint pn = new Paint(Paint.ANTI_ALIAS_FLAG);
        pn.setTypeface(noto(ctx)); pn.setTextSize(px); pn.setColor(color);
        pn.setLetterSpacing(-0.04f); pn.setSubpixelText(true); pn.setFakeBoldText(bold);

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
        // top/bottom(폰트 파일 전체 바운드) 대신 ascent/descent(실 글리프 라인) — Noto CJK의
        // 거대한 top/bottom 메트릭이 모든 텍스트 비트맵에 ~0.5em 유령 여백을 넣어, 4x2 셀
        // (실측 401x217dp)에서 라이브/중계 행이 통째로 잘리던 원인(2026-07-08 하린아빠 제보).
        float top = Math.min(fm.ascent, fn.ascent);
        float bottom = Math.max(fm.descent, fn.descent);
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

    /** 알림 접힌 뷰용 컴팩트 카드 — 홈위젯과 디자인·스펙 동일(비트맵 타이포/상태 문구/중계 틱커).
     *  1행: 로고/약어/점수(or 예정·취소 문구) + 상태 pill, 2행(라이브만): 문자중계 최근 플레이.
     *  경기 없으면 null. */
    static RemoteViews buildCompactCard(Context context) {
        Eff e = readEff(context);
        String away = e.away;
        String home = e.home;
        if (!e.hasGame || away.isEmpty() || home.isEmpty()) return null;

        String myTeam = e.myTeam;
        String bgTeam = !myTeam.isEmpty() ? myTeam : home;
        RemoteViews v = new RemoteViews(context.getPackageName(), R.layout.notif_card_compact);
        int bgRes = draw(context, "widget_bg_" + bgTeam.toLowerCase());
        v.setInt(R.id.ncc_root, "setBackgroundResource", bgRes != 0 ? bgRes : R.drawable.widget_bg_lg);

        int awayLogo = draw(context, "teamlogo_" + away.toLowerCase());
        int homeLogo = draw(context, "teamlogo_" + home.toLowerCase());
        if (awayLogo != 0) v.setImageViewResource(R.id.ncc_away_logo, awayLogo);
        if (homeLogo != 0) v.setImageViewResource(R.id.ncc_home_logo, homeLogo);
        // 약어 — SystemUI(알림)도 런처처럼 커스텀 fontFamily를 무시하므로 홈위젯과 동일 비트맵 렌더.
        v.setImageViewBitmap(R.id.ncc_away_name, textBitmap(context, shortName(away), 14f, 0xFFE8B0BC));
        v.setImageViewBitmap(R.id.ncc_home_name, textBitmap(context, shortName(home), 14f, 0xFFE8B0BC));

        String status = e.status;
        boolean isScheduled = status != null && status.startsWith("SCHEDULED|");
        boolean isFinal = status != null && status.startsWith("FINAL");
        boolean isCancelled = "CANCELLED".equals(status);
        // 예정 status = "SCHEDULED|<시간>|<날짜라벨>" — pill엔 시간만(날짜라벨 제외, 홈위젯과 동일 파싱).
        String schedTime = "";
        if (isScheduled) {
            String sched = status.substring("SCHEDULED|".length());
            int bar = sched.indexOf('|');
            schedTime = bar >= 0 ? sched.substring(0, bar) : sched;
        }
        // 예정/취소 = 점수 숨기고 가운데 문구, 라이브/종료 = 점수 (홈위젯과 동일 규칙).
        if (isScheduled || isCancelled) {
            v.setViewVisibility(R.id.ncc_score, View.GONE);
            v.setViewVisibility(R.id.ncc_score_scheduled, View.VISIBLE);
            v.setImageViewBitmap(R.id.ncc_score_scheduled,
                textBitmap(context, isCancelled ? "경기 취소" : "경기 예정", 16f, 0xFFF5F5F7));
        } else {
            v.setViewVisibility(R.id.ncc_score, View.VISIBLE);
            v.setViewVisibility(R.id.ncc_score_scheduled, View.GONE);
            // 32f bold·순백 — 접힌 카드 스코어 최대화(하린아빠 2026-07-19 "숫자 더 크게").
            // 문자중계 2행을 접힌 뷰에서 제거(아래)해 단일 행이 되므로 로고(26dp) 높이 캡에
            // 묶이지 않고 32f까지 키움(삼순 권고). wrap_content라 좁은 폭에서도 축소 안 됨.
            v.setImageViewBitmap(R.id.ncc_score,
                textBitmap(context, e.as + " : " + e.hs, 32f, 0xFFFFFFFF, true));
        }

        // 상태 pill — 라이브는 "● LIVE N회말"을 최대한 줄여 스코어에 폭을 양보(하린아빠
        // 2026-07-19 "LIVE 2회말 최대한 줄이고"). 빨간 pill 배경 자체가 라이브 신호라
        // "● LIVE " 접두를 떼고 이닝만("2회말") 표기. 예정/종료/취소는 기존 문구 유지.
        if (status.isEmpty() || "SCHEDULED|".equals(status)) {
            v.setViewVisibility(R.id.ncc_status, View.GONE);
        } else {
            v.setViewVisibility(R.id.ncc_status, View.VISIBLE);
            String liveInning = status.replaceFirst("^(?:●\\s*)?LIVE\\s*", "").trim();
            String pill = isCancelled ? "경기 취소" : isScheduled ? schedTime
                : isFinal ? "경기 종료" : liveInning;
            v.setImageViewBitmap(R.id.ncc_status_img, textBitmap(context, pill, 11f, 0xFFFF6B7A));
        }

        // 문자중계 2행은 접힌 카드에서 제거(하린아빠 "아랫줄 비어보임" + 삼순 권고 2026-07-19) —
        // 접힌 뷰는 스코어 최대화 우선, 최근 플레이는 펼친 카드(notif_card_full)에서 유지.
        // notif_card_compact.xml에서 ncc_relay_row 삭제됨 → 여기서도 참조 제거.
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
    /** FCM 라이브 갱신 경로(다음 예정 경기 없음). gameId만 함께 기록해 06:00 롤오버 기준일 유지. */
    static void writeAndRefresh(Context ctx, String myTeam, String away, String home,
                                String as, String hs, String status, String pitcher, String pteam,
                                String batter, String bteam, String outs, String diamond,
                                String stadium, String astarter, String hstarter, String gameId,
                                String lastPlay) {
        writeInternal(ctx, myTeam, away, home, as, hs, status, pitcher, pteam,
            batter, bteam, outs, diamond, stadium, astarter, hstarter, gameId,
            false, "", "", "", "", "", "", "", lastPlay);
    }

    /** 앱(홈) 경로 — 결과/라이브 경기와 함께 '다음 예정 경기'를 실어 위젯 06:00 자동 전환을 준비. */
    static void writeAndRefreshWithNext(Context ctx, String myTeam, String away, String home,
                                String as, String hs, String status, String pitcher, String pteam,
                                String batter, String bteam, String outs, String diamond,
                                String stadium, String astarter, String hstarter, String gameId,
                                String nAway, String nHome, String nStadium, String nTime,
                                String nDate, String nAStarter, String nHStarter) {
        writeInternal(ctx, myTeam, away, home, as, hs, status, pitcher, pteam,
            batter, bteam, outs, diamond, stadium, astarter, hstarter, gameId,
            true, nAway, nHome, nStadium, nTime, nDate, nAStarter, nHStarter, null);
    }

    private static void writeInternal(Context ctx, String myTeam, String away, String home,
                                String as, String hs, String status, String pitcher, String pteam,
                                String batter, String bteam, String outs, String diamond,
                                String stadium, String astarter, String hstarter, String gameId,
                                boolean hasNext, String nAway, String nHome, String nStadium,
                                String nTime, String nDate, String nAStarter, String nHStarter,
                                String lastPlay) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String prevGameId = p.getString(KEY_GAME_ID, "");
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
        e.putString(KEY_GAME_ID, gameId == null ? "" : gameId);
        // last_play 갱신 규칙 (삼순 재리뷰 반영):
        //  - FCM 경로(lastPlay 비-null: ""/텍스트) = 그대로 set/clear
        //  - JS 경로(lastPlay==null) = 기본 보존. 단 *실제* 경기 전환(gameChanged)일 때만 "" clear
        //  - 빈 gameId(경기룸이 gameId 미전달)는 "모름"으로 보고 gameChanged=false → 보존
        //    (경기룸 진입/10초 폴링이 FCM 중계를 지우지 않게). hasNext와 독립.
        boolean gameChanged = !TextUtils.isEmpty(gameId) && !gameId.equals(prevGameId);
        if (lastPlay != null) {
            e.putString(KEY_LAST_PLAY, lastPlay);
        } else if (gameChanged) {
            e.putString(KEY_LAST_PLAY, "");
        }
        if (hasNext) {
            e.putBoolean(KEY_NEXT_HAS, true);
            e.putString(KEY_NEXT_AWAY, nAway == null ? "" : nAway);
            e.putString(KEY_NEXT_HOME, nHome == null ? "" : nHome);
            e.putString(KEY_NEXT_STADIUM, nStadium == null ? "" : nStadium);
            e.putString(KEY_NEXT_TIME, nTime == null ? "" : nTime);
            e.putString(KEY_NEXT_DATE, nDate == null ? "" : nDate);
            e.putString(KEY_NEXT_ASTARTER, nAStarter == null ? "" : nAStarter);
            e.putString(KEY_NEXT_HSTARTER, nHStarter == null ? "" : nHStarter);
        } else if (gameId == null || !gameId.equals(prevGameId)) {
            // 다른 경기로 바뀌면(FCM 라이브 등) 이전 경기의 stale next 제거 → 오탐 롤오버 방지.
            e.putBoolean(KEY_NEXT_HAS, false);
        }
        e.apply();
        refresh(ctx);
    }

    /** 빈 상태로 전환 (경기 종료/이탈). 최애팀 값은 유지. */
    static void clear(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        p.edit().putBoolean(KEY_HAS_GAME, false).apply();
        refresh(ctx);
    }

    /** 경기 종료 처리 — 홈 위젯은 비우지 않고 종료 상태로 남긴다(스코어·gameId·next 보존).
     *  이렇게 해야 앱 미실행 상태에서도 readEff의 06:00 롤오버가 다음 예정 경기로 전환된다.
     *  잠금화면 진행중 알림은 별도로 GameNotificationPlugin.clear()가 내린다(game_end 경로). */
    static void markFinal(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!p.getBoolean(KEY_HAS_GAME, false)) return;
        p.edit().putString(KEY_STATUS, "FINAL").apply();
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
