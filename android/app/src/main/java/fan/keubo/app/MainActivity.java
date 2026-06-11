package fan.keubo.app;

import android.content.pm.ApplicationInfo;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 앱 타깃 커스텀 플러그인은 super.onCreate() 전에 등록해야 브리지가 인식.
        registerPlugin(GameNotificationPlugin.class);
        super.onCreate(savedInstanceState);

        // B1 셸 검증용 — debuggable 빌드에서 런치 시 더미 ongoing notification 1건.
        // (실제 경기 이벤트 연동은 B2, 이 스텁은 그때 제거)
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (debuggable) {
            GameNotificationPlugin.post(this, "LG 3 : 두산 2", "7회말 · 잠실");
        }
    }
}
