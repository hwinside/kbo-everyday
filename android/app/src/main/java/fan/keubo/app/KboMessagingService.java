package fan.keubo.app;

import androidx.annotation.NonNull;

import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

import io.capawesome.capacitorjs.plugins.firebase.messaging.MessagingService;

/**
 * FCM 수신 서비스 — capawesome MessagingService를 확장해서, 앱이 꺼져 있어도
 * 경기 라이브 data 푸시를 받으면 잠금화면 ongoing notification + 홈 위젯을 갱신한다.
 * (A4 푸시 자동 시작 C1 — 앱 미진입 자동 표시)
 *
 * super 호출로 플러그인의 기존 동작(토큰 갱신, JS 이벤트 전달, notification 메시지 표시)은
 * 그대로 유지. 추가로 data.kind == "game_live"/"game_end"를 네이티브로 처리한다.
 *
 * 매니페스트에서 이 서비스가 플러그인 MessagingService를 대체 등록한다(tools:node="remove").
 */
public class KboMessagingService extends MessagingService {

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);

        Map<String, String> data = remoteMessage.getData();
        if (data == null) {
            return;
        }
        String kind = data.get("kind");
        if ("game_live".equals(kind)) {
            String title = data.get("title");
            String body = data.get("body");
            // url(=/games/{gameId})은 서버가 data에 실어 보냄 — 카드 탭 시 경기룸 딥링크용(②).
            String path = data.get("url");
            // 카드 데이터(prefs)를 *먼저* 기록 — 알림 커스텀 카드와 홈 위젯이 같은 prefs를 읽는다.
            // 팀/점수/이닝은 서버가 gameId에서 파싱한 2자 코드로 실어 보냄. 최애팀(w_my)은 보통
            // 비어 있어 디바이스 저장값(앱이 기록)을 유지. 주자/투수/타자는 푸시엔 없어 비움
            // (경기룸 포그라운드 진입 시 풀 데이터로 채워짐).
            GameScoreWidget.writeAndRefresh(
                this,
                data.get("w_my"),
                data.get("w_away"),
                data.get("w_home"),
                data.get("w_as"),
                data.get("w_hs"),
                data.get("w_status"),
                data.get("w_pitcher"),
                data.get("w_pteam"),
                data.get("w_batter"),
                data.get("w_bteam"),
                data.get("w_outs"),
                data.get("w_diamond"));
            // 그 다음 잠금화면 알림 카드 게시(prefs 기반 RemoteViews).
            GameNotificationPlugin.post(
                this,
                title == null || title.isEmpty() ? "크보팬" : title,
                body == null ? "" : body,
                path == null ? "" : path);
        } else if ("game_end".equals(kind)) {
            GameNotificationPlugin.clear(this);
            GameScoreWidget.clear(this);
        }
    }
}
