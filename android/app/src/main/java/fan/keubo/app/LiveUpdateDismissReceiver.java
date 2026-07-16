package fan.keubo.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Live Update(Promoted Ongoing) 카드의 deleteIntent 수신 — 유저가 카드를 Unpin(스와이프 해제)한
 * 시점에만 발화한다. 해당 경기(gameId)를 억제 목록에 기록해 FCM/JS 갱신이 같은 경기를 자동
 * 재게시하지 않게 한다(스포츠 Live Update 계약). 다음 경기는 gameId가 달라 자연 해제되고,
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
    }
}
