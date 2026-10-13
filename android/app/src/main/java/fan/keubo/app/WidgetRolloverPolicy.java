package fan.keubo.app;

import java.util.Calendar;
import java.util.TimeZone;

/** KST game-day expiry shared by all Android game widget render paths. */
final class WidgetRolloverPolicy {
    static final int KEEP = 0, NEXT = 1, EMPTY = 2;

    static int resolve(boolean hasGame, String status, String gameId,
                       boolean hasNext, String nextGameId, long now) {
        Long expiry = expiry(gameId);
        if (!hasGame || expiry == null || now < expiry) return KEEP;
        if (hasNext) {
            Long nextExpiry = expiry(nextGameId);
            // Legacy caches without an ID cannot establish a valid next fixture.
            return nextExpiry != null && now < nextExpiry ? NEXT : EMPTY;
        }
        return status != null && (status.startsWith("FINAL")
            || status.equals("CANCELLED") || status.startsWith("SCHEDULED|")) ? EMPTY : KEEP;
    }

    static Long expiry(String gameId) {
        if (gameId == null || gameId.length() < 8) return null;
        try {
            if (!gameId.substring(0, 8).matches("[0-9]{8}")) return null;
            Calendar cal = Calendar.getInstance(TimeZone.getTimeZone("Asia/Seoul"));
            cal.setLenient(false);
            cal.clear();
            cal.set(Integer.parseInt(gameId.substring(0, 4)),
                Integer.parseInt(gameId.substring(4, 6)) - 1,
                Integer.parseInt(gameId.substring(6, 8)), 6, 0, 0);
            cal.getTimeInMillis(); // Validate before rolling over the calendar day.
            cal.add(Calendar.DAY_OF_MONTH, 1);
            return cal.getTimeInMillis();
        } catch (IllegalArgumentException ex) {
            return null;
        }
    }
}
