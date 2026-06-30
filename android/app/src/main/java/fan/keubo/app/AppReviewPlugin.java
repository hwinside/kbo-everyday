package fan.keubo.app;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.tasks.Task;
import com.google.android.play.core.review.ReviewInfo;
import com.google.android.play.core.review.ReviewManager;
import com.google.android.play.core.review.ReviewManagerFactory;

/**
 * 인앱 Google Play 리뷰 요청 — Play In-App Review API.
 * Play가 표시 빈도를 자체 제한한다(quota 초과/조건 미달 시 미표시, best-effort).
 * JS(native-app-review.ts)가 앱 실행 10회 이상 + 홈 진입 시 1회 호출.
 */
@CapacitorPlugin(name = "AppReview")
public class AppReviewPlugin extends Plugin {

    @PluginMethod
    public void requestReview(PluginCall call) {
        final ReviewManager manager = ReviewManagerFactory.create(getContext());
        Task<ReviewInfo> request = manager.requestReviewFlow();
        request.addOnCompleteListener(task -> {
            if (task.isSuccessful() && getActivity() != null) {
                ReviewInfo reviewInfo = task.getResult();
                manager.launchReviewFlow(getActivity(), reviewInfo)
                    .addOnCompleteListener(flow -> call.resolve());
            } else {
                // 실패/조건 미달이어도 조용히 성공 처리 — 인앱 리뷰는 best-effort.
                call.resolve();
            }
        });
    }
}
