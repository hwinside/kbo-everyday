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
 * 그대로 유지. 추가로 data.kind == "game_live"/"game_cancel"/"game_end"를 네이티브로 처리한다.
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
            // gameId = url("/games/{gameId}") 마지막 세그먼트 → 06:00 롤오버 기준일.
            String gameId = "";
            if (path != null) {
                int slash = path.lastIndexOf('/');
                gameId = slash >= 0 ? path.substring(slash + 1) : path;
            }
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
                data.get("w_diamond"),
                data.get("w_stadium"),
                data.get("w_astarter"),
                data.get("w_hstarter"),
                gameId,
                data.get("w_lastplay"));
            // 그 다음 잠금화면 알림 카드 게시(prefs 기반 RemoteViews).
            GameNotificationPlugin.post(
                this,
                title == null || title.isEmpty() ? "크보팬" : title,
                body == null ? "" : body,
                path == null ? "" : path);
        } else if ("game_cancel".equals(kind)) {
            // 경기 취소 — 홈위젯은 "경기 취소"(CANCELLED)로 갱신하되, 잠금화면 진행중 알림은
            // post하지 않고 내린다(정책: 잠금화면은 정리, 홈위젯은 유지). game_live처럼 post()를
            // 태우면 "잠금화면 없앤다"는 정책과 충돌하므로 별도 kind로 분리했다.
            // writeAndRefresh(hasNext=false)는 같은 gameId면 기존 next를 건드리지 않으므로,
            // 앱 오픈으로 next가 캐시된 기기는 06:00 롤오버가 유지되고, push-only 기기는 다음
            // 경기 pregame push가 위젯을 덮어써 자연 복구된다.
            String path = data.get("url");
            String gameId = "";
            if (path != null) {
                int slash = path.lastIndexOf('/');
                gameId = slash >= 0 ? path.substring(slash + 1) : path;
            }
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
                data.get("w_diamond"),
                data.get("w_stadium"),
                data.get("w_astarter"),
                data.get("w_hstarter"),
                gameId,
                "");
            // 잠금화면 진행중 알림 제거(post 아님) — 취소 시 잠금화면은 비운다.
            GameNotificationPlugin.clear(this);
        } else if ("game_end".equals(kind)) {
            // 잠금화면 진행중 알림은 내리되, 홈 위젯은 비우지 않고 종료 상태로 남긴다
            // (스코어·gameId·next 보존) → 앱 미실행 상태에서도 다음날 06:00에 다음 예정
            // 경기로 자동 롤오버(readEff). 통째 clear하면 hasGame=false라 롤오버가 무력화됨.
            GameNotificationPlugin.clear(this);
            GameScoreWidget.markFinal(this);
        }
    }
}
