package fan.keubo.app;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.core.content.res.ResourcesCompat;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 최애선수 카드 위젯 설정 — 위젯 추가 시 표시할 최애선수 선택.
 * 목록은 앱이 GameNotification.setFavPlayers 브리지로 동기화한 prefs(fav_players)를 읽는다.
 * 목록이 비면(앱 미로그인/미동기화) 안내 문구만 표시.
 */
public class PlayerCardWidgetConfigure extends Activity {

    private int widgetId = AppWidgetManager.INVALID_APPWIDGET_ID;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setResult(RESULT_CANCELED);

        Bundle extras = getIntent().getExtras();
        if (extras != null) {
            widgetId = extras.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID,
                AppWidgetManager.INVALID_APPWIDGET_ID);
        }
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish();
            return;
        }

        JSONArray players = readFavPlayers();

        LinearLayout list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        list.setBackgroundColor(0xFF0A0A0B);
        int pad = (int) (16 * getResources().getDisplayMetrics().density);
        list.setPadding(pad, pad, pad, pad);

        Typeface noto = null;
        try {
            noto = ResourcesCompat.getFont(this, R.font.notosanskr_vf);
        } catch (Exception ignored) { }

        TextView title = row("표시할 최애선수 선택", 17, 0xFFF5F5F7, noto);
        title.setTypeface(title.getTypeface(), Typeface.BOLD);
        list.addView(title);

        if (players == null || players.length() == 0) {
            TextView empty = row("앱에서 최애선수를 먼저 등록한 뒤\n홈 화면을 한 번 열어주세요.", 14, 0xFF8E8E93, noto);
            list.addView(empty);
        } else {
            for (int i = 0; i < players.length(); i++) {
                JSONObject p = players.optJSONObject(i);
                if (p == null) continue;
                final String kboId = p.optString("playerId", "");
                String name = p.optString("name", "");
                String position = p.optString("position", "");
                if (kboId.isEmpty() || name.isEmpty()) continue;
                TextView item = row(name + "  ·  " + position, 15, 0xFFF5F5F7, noto);
                item.setBackgroundColor(0xFF141416);
                item.setOnClickListener(v -> select(kboId));

                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
                lp.topMargin = pad / 2;
                list.addView(item, lp);
            }
        }

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(0xFF0A0A0B);
        scroll.addView(list);
        setContentView(scroll);
    }

    private TextView row(String text, int sp, int color, Typeface tf) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextSize(sp);
        tv.setTextColor(color);
        if (tf != null) tv.setTypeface(tf);
        tv.setGravity(Gravity.CENTER_VERTICAL);
        int pad = (int) (14 * getResources().getDisplayMetrics().density);
        tv.setPadding(pad, pad, pad, pad);
        return tv;
    }

    private JSONArray readFavPlayers() {
        try {
            String raw = getSharedPreferences(PlayerCardWidget.PREFS, Context.MODE_PRIVATE)
                .getString(PlayerCardWidget.KEY_FAV_PLAYERS, "");
            if (!raw.isEmpty()) return new JSONArray(raw);
        } catch (Exception ignored) { }
        return null;
    }

    private void select(String kboId) {
        getSharedPreferences(PlayerCardWidget.PREFS, Context.MODE_PRIVATE).edit()
            .putString(PlayerCardWidget.KEY_PLAYER_PREFIX + widgetId, kboId)
            .apply();

        // 즉시 1회 fetch 후 렌더 — 위젯이 빈 채로 남지 않게
        final Context app = getApplicationContext();
        new Thread(() -> {
            PlayerCardWidget.fetchAndStore(app, kboId);
            PlayerCardWidget.renderAllFromCache(app);
        }).start();
        PlayerCardWidget.renderAllFromCache(app);

        Intent result = new Intent();
        result.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        setResult(RESULT_OK, result);
        finish();
    }
}
