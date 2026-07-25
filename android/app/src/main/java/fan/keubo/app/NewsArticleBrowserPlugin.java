package fan.keubo.app;

import android.content.Intent;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NewsArticleBrowser")
public class NewsArticleBrowserPlugin extends Plugin {
    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        if (!NewsArticleBrowserActivity.isHttpUrl(url)) {
            call.reject("A valid http(s) article URL is required");
            return;
        }

        String commentsUrl = NewsArticleBrowserActivity.validCommentsUrl(
            call.getString("commentsUrl")
        );
        Integer teamId = call.getInt("teamId");
        getActivity().runOnUiThread(() -> {
            Intent intent = new Intent(getActivity(), NewsArticleBrowserActivity.class);
            intent.putExtra(NewsArticleBrowserActivity.EXTRA_URL, url);
            if (commentsUrl != null) {
                intent.putExtra(NewsArticleBrowserActivity.EXTRA_COMMENTS_URL, commentsUrl);
            }
            if (teamId != null) {
                intent.putExtra(NewsArticleBrowserActivity.EXTRA_TEAM_ID, teamId.intValue());
            }
            getActivity().startActivity(intent);
            call.resolve();
        });
    }
}

