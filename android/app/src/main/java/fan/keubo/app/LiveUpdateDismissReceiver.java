package fan.keubo.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Live Update(Promoted Ongoing) 카드의 해제 수신 — 유저가 카드를 스와이프로 Unpin하거나(deleteIntent)
 * 카드 내 명시적 "해제" 액션을 탭했을 때(addAction) 둘 다 이리로 온다. 해당 경기(gameId)를 억제
 * 목록에 기록해 FCM/JS 갱신이 같은 경기를 자동 재게시하지 않게 하고(스포츠 Live Update 계약),
 * 알림을 즉시 취소한다(액션 탭은 스와이프와 달리 알림을 자동으로 지우지 않음 — 스와이프 경로는
 * 이미 제거된 ID를 cancel하는 것이라 무해한 중복 호출). 다음 경기는 gameId가 달라 자연 해제되고,
 * 마이페이지 opt-in 토글 변경 시에도 리셋된다.
 */
public class LiveUpdateDismissReceiver extends BroadcastReceiver {

    static final String EXTRA_GAME_ID = "kbo_game_id";

    @Override
    public void onReceive(Context context, Intent intent) {
        String gameId = intent != null ? intent.getStringExtra(EXTRA_GAME_ID) : null;
        if (gameId == null || gameId.isEmpty()) return;
        context.getSharedPreferences(GameNotificationPlugin.LU_PREFS, Context.MODE_PRIVATE).edit()
            .putString(GameNotificationPlugin.LU_KEY_SUPPRESSED_GAME, gameId)
            .apply();
        GameNotificationPlugin.clear(context);
    }
}
