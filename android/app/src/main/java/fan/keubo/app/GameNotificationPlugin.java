package fan.keubo.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.widget.RemoteViews;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 잠금화면 실시간 스코어 = 커스텀 레이아웃 ongoing notification (iOS Live Activity의 안드로이드판).
 * 삼성 One UI 잠금화면은 서드파티 위젯을 허용하지 않으므로(시스템 앱 전용), 잠금화면 카드는
 * 위젯이 아니라 *위젯과 동일한 RemoteViews 카드*를 알림 커스텀 뷰로 그려서 표시한다(네이버 방식).
 * 카드 데이터는 GameScoreWidget의 SharedPreferences(kbo_game_widget)를 공유 — 위젯/알림 동일.
 * 잠금화면 노출 위해 IMPORTANCE_DEFAULT + VISIBILITY_PUBLIC. 동일 ID re-notify로 갱신, cancel로 제거.
 *
 * Android 16+(One UI 8.5) Live Update: 유저가 마이페이지에서 명시 opt-in한 경우에만
 * 표준 스타일(BigText) 알림 + setRequestPromotedOngoing(true)으로 잠금화면 라이브 카드 승격을
 * 요청한다. Live Update는 커스텀 뷰(DecoratedCustomViewStyle)를 승격 대상에서 제외하므로
 * promoted 분기는 RemoteViews 카드를 쓰지 않고, 비대상(미지원 OS/opt-out)은 기존 커스텀
 * 카드 경로 그대로다. 유저가 카드를 Unpin(스와이프 해제)하면 deleteIntent로 감지해 같은
 * 경기(gameId)는 자동 재게시하지 않는다.
 */
@CapacitorPlugin(name = "GameNotification")
public class GameNotificationPlugin extends Plugin {

    // v3: 커스텀 카드 + 잠금화면 가시성(IMPORTANCE_DEFAULT). 채널 importance는 생성 후 못 올리므로 새 ID.
    private static final String CHANNEL_ID = "game_live_card";
    private static final int NOTIFICATION_ID = 7001;

    // Live Update opt-in/Unpin 상태 — 디바이스 로컬(SharedPreferences).
    static final String LU_PREFS = "kbo_live_update";
    static final String LU_KEY_OPT_IN = "opt_in";
    static final String LU_KEY_SUPPRESSED_GAME = "suppressed_game_id";

    /** Android 16+(API 36)이고 시스템이 이 앱의 promoted 게시를 허용하는지. */
    static boolean liveUpdateSupported(Context context) {
        if (Build.VERSION.SDK_INT < 36) return false;
        NotificationManager mgr = context.getSystemService(NotificationManager.class);
        return mgr != null && mgr.canPostPromotedNotifications();
    }

    static boolean liveUpdateOptedIn(Context context) {
        return context.getSharedPreferences(LU_PREFS, Context.MODE_PRIVATE)
            .getBoolean(LU_KEY_OPT_IN, false);
    }

    /** path("/games/{gameId}")에서 gameId 추출 — KboMessagingService와 동일 규칙. */
    private static String gameIdFromPath(String path) {
        if (path == null || path.isEmpty()) return "";
        int slash = path.lastIndexOf('/');
        return slash >= 0 ? path.substring(slash + 1) : path;
    }

    /** 현재 카드의 경기 식별자. JS start/update는 path 없이 호출되므로(경기룸 포그라운드)
     *  위젯 prefs의 gameId로 폴백 — Unpin 억제가 FCM/JS 경로 모두에서 같은 경기를 가리키게. */
    private static String currentGameId(Context context, String path) {
        String fromPath = gameIdFromPath(path);
        if (!fromPath.isEmpty()) return fromPath;
        return context.getSharedPreferences(GameScoreWidget.PREFS, Context.MODE_PRIVATE)
            .getString(GameScoreWidget.KEY_GAME_ID, "");
    }

    /** 승격(Live Update) 카드용 텍스트 조합 — 표준 스타일 카드는 push title/body 텍스트만
     *  보이는데, FCM game_live의 title/body엔 점수/이닝이 없다(구조화 w_*는 위젯 prefs로만
     *  전달되고 기존 커스텀 카드는 prefs를 직접 그려서 문제가 안 드러났음). 위젯과 동일한
     *  prefs 스냅샷(Eff)에서 "롯데 1 : 3 삼성 · 8회초" + 최근 플레이 줄을 직접 만든다.
     *  순수 함수 — ComposeLiveCardTest 유닛테스트 대상.
     *  @return [title, body]. prefs에 경기 데이터가 없으면 push 원문 폴백 */
    static String[] composeLiveCard(GameScoreWidget.Eff e, String fallbackTitle, String fallbackBody) {
        String fb = fallbackBody == null ? "" : fallbackBody;
        if (e == null || !e.hasGame || e.away.isEmpty() || e.home.isEmpty()) {
            return new String[] { fallbackTitle == null ? "" : fallbackTitle, fb };
        }
        String away = GameScoreWidget.shortName(e.away);
        String home = GameScoreWidget.shortName(e.home);
        String st = e.status == null ? "" : e.status;
        String title;
        if (st.startsWith("SCHEDULED|")) {
            // 예정 카드(프리게임 push) — 점수 대신 매치업 + 시작 시각.
            String[] parts = st.split("\\|", -1);
            String time = parts.length > 1 ? parts[1] : "";
            title = away + " vs " + home + (time.isEmpty() ? " · 경기 예정" : " · " + time + " 경기 예정");
        } else {
            String suffix = "CANCELLED".equals(st) ? "경기 취소"
                : st.startsWith("FINAL") ? "경기 종료"
                : st; // 라이브 = "8회초" 등
            title = away + " " + e.as + " : " + e.hs + " " + home
                + (suffix.isEmpty() ? "" : " · " + suffix);
        }
        String body = !e.lastPlay.isEmpty() ? e.lastPlay : !fb.isEmpty() ? fb : e.stadium;
        return new String[] { title, body == null ? "" : body };
    }

    /** 라이브 상태면 승격 카드를 ProgressStyle(9이닝 진행바)로 업그레이드.
     *  타이틀=스코어, 서브텍스트=구장·이닝, 본문=아웃도트(●옐로우)·주자·투타,
     *  largeIcon=다이아몬드(레드)+아웃 패널, 진행바=이닝 세그먼트 팀컬러+팀로고 트래커.
     *  라이브가 아니면(예정/종료/취소/파싱 실패) 기존 BigText 유지. */
    private static void applyLiveProgressCard(Context context, NotificationCompat.Builder b,
                                              GameScoreWidget.Eff e) {
        if (e == null || !e.hasGame || e.status == null || e.status.isEmpty()) return;
        if (e.status.startsWith("SCHEDULED|") || e.status.startsWith("FINAL")
            || "CANCELLED".equals(e.status)) return;
        java.util.regex.Matcher m =
            java.util.regex.Pattern.compile("(\\d+)회(초|말)").matcher(e.status);
        if (!m.find()) return;
        int inning;
        try { inning = Math.min(Math.max(Integer.parseInt(m.group(1)), 1), 15); }
        catch (NumberFormatException ex) { return; }
        String inningLabel = m.group(1) + "회" + m.group(2);

        String away = GameScoreWidget.shortName(e.away);
        String home = GameScoreWidget.shortName(e.home);
        b.setContentTitle(away + " " + e.as + " : " + e.hs + " " + home);
        b.setSubText(e.stadium.isEmpty() ? inningLabel : e.stadium + " · " + inningLabel);

        // 본문: ●○○ 1사 1·3루 · 투수 X vs 타자 Y (빈 정보는 생략)
        int outCount = 0;
        try {
            outCount = Math.min(Math.max(
                Integer.parseInt(e.outs.isEmpty() ? "0" : e.outs), 0), 3);
        } catch (NumberFormatException ignored) { }
        StringBuilder t = new StringBuilder();
        for (int i = 0; i < 3; i++) t.append(i < outCount ? "●" : "○");
        t.append(" ").append(outCount).append("사");
        String bases = baseSummary(e.diamond);
        if (!bases.isEmpty()) t.append(" ").append(bases);
        if (!e.pitcher.isEmpty() && !e.batter.isEmpty()) {
            // "투/타" 압축 표기 — 좁은 화면 잘림 방지(삼순 권고).
            t.append(" · 투 ").append(e.pitcher).append(" / 타 ").append(e.batter);
        } else if (!e.batter.isEmpty()) {
            t.append(" · 타 ").append(e.batter);
        }
        // 문자중계 최근 플레이 한 줄 — 승격 카드 본문  2줄째(One UI 접힘 렌더 실측 확인).
        if (!e.lastPlay.isEmpty()) t.append("\n").append(e.lastPlay);
        b.setContentText(t.toString());
        b.setLargeIcon(GameScoreWidget.buildDiamondOutsIcon(e.diamond, e.outs));

        // 9이닝 세그먼트(연장이면 확장) — 지난·현재 이닝 팀컬러, 남은 이닝 다크.
        String accentTeam = !e.myTeam.isEmpty() ? e.myTeam : e.home;
        int accent = GameScoreWidget.teamAccent(accentTeam);
        int total = Math.max(inning, 9);
        java.util.List<NotificationCompat.ProgressStyle.Segment> segs = new java.util.ArrayList<>();
        for (int i = 1; i <= total; i++) {
            segs.add(new NotificationCompat.ProgressStyle.Segment(1)
                .setColor(i <= inning ? accent : 0xFF3A4150));
        }
        NotificationCompat.ProgressStyle ps = new NotificationCompat.ProgressStyle()
            .setStyledByProgress(false)
            .setProgressSegments(segs)
            .setProgress(inning);
        int logoRes = context.getResources().getIdentifier(
            "teamlogo_" + accentTeam.toLowerCase(), "drawable", context.getPackageName());
        if (logoRes != 0) {
            ps.setProgressTrackerIcon(
                androidx.core.graphics.drawable.IconCompat.createWithResource(context, logoRes));
        }
        b.setStyle(ps);
    }

    /** diamond 비트("101")를 "1·3루" 요약으로. 주자 없으면 빈 문자열. */
    private static String baseSummary(String diamond) {
        if (diamond == null || diamond.length() < 3) return "";
        StringBuilder n = new StringBuilder();
        if (diamond.charAt(0) == '1') n.append("1");
        if (diamond.charAt(1) == '1') n.append(n.length() > 0 ? "·2" : "2");
        if (diamond.charAt(2) == '1') n.append(n.length() > 0 ? "·3" : "3");
        return n.length() > 0 ? n.append("루").toString() : "";
    }

    private static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "실시간 경기", NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("잠금화면 실시간 스코어 카드");
            channel.setShowBadge(false);
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            NotificationManager mgr = context.getSystemService(NotificationManager.class);
            if (mgr != null) {
                mgr.createNotificationChannel(channel);
                // 구 LOW 채널 제거(잔존 시 잠금화면 숨김 + 중복 노출).
                mgr.deleteNotificationChannel("game_live");
            }
        }
    }

    /** 카드 탭 시 열 앱 내 경로(예: /games/20260612...). MainActivity가 이 extra를 읽어 웹뷰 이동. */
    static final String EXTRA_PATH = "kbo_path";

    private static Notification build(Context context, String title, String body, String path,
                                      boolean promoted) {
        ensureChannel(context);
        // 카드 탭 → 해당 경기룸 딥링크(②). path가 있으면 MainActivity를 extra와 함께 열고,
        // 없으면(레거시/직접 호출) 기존대로 앱 홈을 연다.
        PendingIntent pi;
        if (path != null && !path.isEmpty()) {
            Intent i = new Intent(context, MainActivity.class);
            i.putExtra(EXTRA_PATH, path);
            // 이미 떠 있는 인스턴스로 전달(onNewIntent) — 새 액티비티 스택 쌓지 않음.
            i.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            // request code 1 = 딥링크용(홈은 0). FLAG_UPDATE_CURRENT로 path 갱신 반영.
            pi = PendingIntent.getActivity(
                context, 1, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        } else {
            Intent launch = context.getPackageManager()
                .getLaunchIntentForPackage(context.getPackageName());
            pi = PendingIntent.getActivity(
                context, 0, launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        }

        NotificationCompat.Builder b = new NotificationCompat.Builder(context, CHANNEL_ID)
            // 모노크롬 small icon — 컬러 launcher를 쓰면 상태바에 흰 사각형으로 뭉개짐.
            .setSmallIcon(R.drawable.ic_stat_kbo)
            .setContentTitle(title)
            .setContentText(body)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(pi);

        if (promoted) {
            // Live Update 분기 — 표준 스타일만 승격 대상(커스텀 뷰 금지). 점수/이닝/최근 플레이는
            // 위젯 prefs에서 직접 조합(FCM title/body엔 없음 — composeLiveCard 주석 참조).
            GameScoreWidget.Eff eff = GameScoreWidget.readEff(context);
            String[] tb = composeLiveCard(eff, title, body);
            b.setContentTitle(tb[0])
                .setContentText(tb[1])
                .setStyle(new NotificationCompat.BigTextStyle().bigText(tb[1]))
                .setRequestPromotedOngoing(true);
            // 라이브 상태는 ProgressStyle(이닝 진행바) 카드로 업그레이드 —
            // 예정/종료/취소는 위 BigText 그대로(no-op).
            applyLiveProgressCard(context, b, eff);
            String gameId = currentGameId(context, path);
            // Unpin(유저 스와이프 해제) 감지 → 같은 경기 자동 재게시 억제. deleteIntent는
            // 유저 해제 시에만 발화(cancel()로는 미발화)라 non-promoted 경로 행동 불변.
            Intent del = new Intent(context, LiveUpdateDismissReceiver.class);
            del.putExtra(LiveUpdateDismissReceiver.EXTRA_GAME_ID, gameId);
            b.setDeleteIntent(PendingIntent.getBroadcast(
                context, 2, del,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
            // 명시적 "해제" 액션 — Android Live Update 가이드가 배경 스포츠 경기 모니터링
            // 알림에 유저가 직접 끌 수 있는 액션을 요구(스와이프만으로는 불충분).
            // 같은 수신자(LiveUpdateDismissReceiver)로 보내 억제 기록+알림 취소를 동일 경로로.
            Intent unpin = new Intent(context, LiveUpdateDismissReceiver.class);
            unpin.putExtra(LiveUpdateDismissReceiver.EXTRA_GAME_ID, gameId);
            PendingIntent unpinPi = PendingIntent.getBroadcast(
                context, 3, unpin,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            b.addAction(android.R.drawable.ic_menu_close_clear_cancel,
                context.getString(R.string.live_update_unpin_action), unpinPi);
        } else if (GameScoreWidget.hasGame(context)) {
            // 기존 경로(미지원 OS/opt-out) — 위젯과 동일한 카드 RemoteViews를 알림 커스텀 뷰로.
            // 접힌 뷰(잠금화면 기본) = 점수 한 줄 컴팩트 카드, 펼친 뷰 = 전체 카드.
            RemoteViews compact = GameScoreWidget.buildCompactCard(context);
            RemoteViews full = GameScoreWidget.buildNotifFullCard(context);
            full.setOnClickPendingIntent(R.id.widget_root, pi);
            b.setStyle(new NotificationCompat.DecoratedCustomViewStyle())
                .setCustomContentView(compact != null ? compact : full)
                .setCustomBigContentView(full);
        }
        return b.build();
    }

    /** ongoing notification 게시/갱신 (동일 ID라 갱신은 re-notify) + 홈 위젯 동기 갱신.
     *  path = 카드 탭 시 열 경기룸 경로(없으면 홈). */
    static void post(Context context, String title, String body, String path) {
        boolean promoted = liveUpdateSupported(context) && liveUpdateOptedIn(context);
        if (promoted) {
            // 유저가 이 경기 카드를 Unpin함 — 같은 경기는 재게시하지 않는다(Live Update 계약).
            String gameId = currentGameId(context, path);
            String suppressed = context.getSharedPreferences(LU_PREFS, Context.MODE_PRIVATE)
                .getString(LU_KEY_SUPPRESSED_GAME, "");
            if (!gameId.isEmpty() && gameId.equals(suppressed)) return;
        }
        try {
            NotificationManagerCompat.from(context)
                .notify(NOTIFICATION_ID, build(context, title, body, path, promoted));
        } catch (SecurityException ignored) {
            // POST_NOTIFICATIONS 미허용 — 무시 (권한 UX가 별도 처리)
        }
        // 위젯(GameScoreWidget)은 구조화 데이터로 별도 구동(KboMessagingService / JS updateWidget).
        // 여기서 title/sub로 위젯을 건드리지 않는다.
    }

    static void clear(Context context) {
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID);
    }

    @PluginMethod
    public void start(PluginCall call) {
        post(getContext(), call.getString("title", "크보팬"), call.getString("body", ""),
            call.getString("path", ""));
        call.resolve();
    }

    @PluginMethod
    public void update(PluginCall call) {
        post(getContext(), call.getString("title", "크보팬"), call.getString("body", ""),
            call.getString("path", ""));
        call.resolve();
    }

    @PluginMethod
    public void remove(PluginCall call) {
        clear(getContext());
        call.resolve();
    }

    /** 경기룸(포그라운드)에서 풀 라이브 데이터로 위젯 갱신 (OUT/주자/투수·타자 소속 포함). */
    @PluginMethod
    public void updateWidget(PluginCall call) {
        String myTeam = call.getString("myTeam", "");
        String away = call.getString("away", "");
        String home = call.getString("home", "");
        String as = call.getString("awayScore", "0");
        String hs = call.getString("homeScore", "0");
        String status = call.getString("status", "");
        String pitcher = call.getString("pitcher", "");
        String pteam = call.getString("pitcherTeam", "");
        String batter = call.getString("batter", "");
        String bteam = call.getString("batterTeam", "");
        String outs = call.getString("outs", "");
        String diamond = call.getString("diamond", "000");
        String stadium = call.getString("stadium", "");
        String astarter = call.getString("awayStarter", "");
        String hstarter = call.getString("homeStarter", "");
        String gameId = call.getString("gameId", "");
        JSObject next = call.getObject("next");
        if (next != null) {
            GameScoreWidget.writeAndRefreshWithNext(
                getContext(), myTeam, away, home, as, hs, status, pitcher, pteam,
                batter, bteam, outs, diamond, stadium, astarter, hstarter, gameId,
                next.optString("away", ""), next.optString("home", ""),
                next.optString("stadium", ""), next.optString("time", ""),
                next.optString("date", ""), next.optString("astarter", ""),
                next.optString("hstarter", ""));
        } else {
            GameScoreWidget.writeAndRefresh(
                getContext(), myTeam, away, home, as, hs, status, pitcher, pteam,
                batter, bteam, outs, diamond, stadium, astarter, hstarter, gameId, null);
        }
        call.resolve();
    }

    /** 위젯 빈 상태로 전환 (경기 종료). */
    @PluginMethod
    public void clearWidget(PluginCall call) {
        GameScoreWidget.clear(getContext());
        call.resolve();
    }

    /** 디바이스 최애팀 코드 기록 (위젯 배경/워터마크 색 결정). */
    @PluginMethod
    public void setMyTeam(PluginCall call) {
        String code = call.getString("code", "");
        GameScoreWidget.setMyTeam(getContext(), code);
        // 순위 위젯은 최애팀 행 하이라이트가 바뀌므로 캐시로 즉시 재렌더
        TeamRankWidget.renderAllFromCache(getContext());
        pushMyTeamToWatch(code);
        call.resolve();
    }

    /**
     * 갤럭시워치(Wear OS) 최애팀 동기화 — 애플워치 WCSession(WatchSyncManager)의 안드로이드판.
     * Data Layer /kbo/my_team에 최신값 기록(latest-value 시맨틱). 워치 미연결/GMS 이상은
     * 조용히 무시 — 폰 기능에 영향을 주면 안 된다.
     */
    private void pushMyTeamToWatch(String code) {
        // 빈 코드(최애팀 해제)도 push — 워치가 이전 팀 캐시/스냅샷을 무효화해야 한다
        if (code == null) code = "";
        try {
            com.google.android.gms.wearable.PutDataMapRequest req =
                    com.google.android.gms.wearable.PutDataMapRequest.create("/kbo/my_team");
            req.getDataMap().putString("code", code.toUpperCase(java.util.Locale.ROOT));
            // 동일 팀 재선택에도 change 이벤트가 발생하도록 타임스탬프 동봉
            req.getDataMap().putLong("at", System.currentTimeMillis());
            com.google.android.gms.wearable.Wearable.getDataClient(getContext())
                    .putDataItem(req.asPutDataRequest().setUrgent());
        } catch (Exception ignored) {
        }
    }

    /** Live Update 지원/opt-in 상태 — 마이페이지 토글 노출 게이트(미지원 기기엔 토글 숨김). */
    @PluginMethod
    public void getLiveUpdateState(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("supported", liveUpdateSupported(getContext()));
        ret.put("enabled", liveUpdateOptedIn(getContext()));
        call.resolve(ret);
    }

    /** Live Update 명시 opt-in 토글. 토글 변경 시 Unpin 억제 상태도 리셋. */
    @PluginMethod
    public void setLiveUpdateOptIn(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        getContext().getSharedPreferences(LU_PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean(LU_KEY_OPT_IN, enabled)
            .remove(LU_KEY_SUPPRESSED_GAME)
            .apply();
        call.resolve();
    }

    /** 최애선수 목록 동기화 — 선수 카드 위젯 config(선수 선택 목록)가 읽는다.
     *  json = [{playerId,name,teamId,position,number}] (FavoritePlayer 직렬화). */
    @PluginMethod
    public void setFavPlayers(PluginCall call) {
        String json = call.getString("json", "");
        getContext().getSharedPreferences(PlayerCardWidget.PREFS, Context.MODE_PRIVATE).edit()
            .putString(PlayerCardWidget.KEY_FAV_PLAYERS, json == null ? "" : json)
            .apply();
        call.resolve();
    }
}
