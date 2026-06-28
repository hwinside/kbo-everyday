package fan.keubo.app;

import android.os.Bundle;

import com.facebook.appevents.AppEventsLogger;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Iterator;

@CapacitorPlugin(name = "MetaAppEvents")
public class MetaAppEventsPlugin extends Plugin {
    @PluginMethod
    public void logEvent(PluginCall call) {
        String name = call.getString("name");
        if (name == null || name.isEmpty()) {
            call.reject("name is required");
            return;
        }

        Bundle parameters = toBundle(call.getObject("parameters", new JSObject()));
        AppEventsLogger.newLogger(getContext()).logEvent(name, parameters);
        call.resolve();
    }

    private Bundle toBundle(JSObject object) {
        Bundle bundle = new Bundle();
        Iterator<String> keys = object.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            Object value = object.opt(key);
            if (value instanceof String) {
                bundle.putString(key, (String) value);
            } else if (value instanceof Integer) {
                bundle.putInt(key, (Integer) value);
            } else if (value instanceof Long) {
                bundle.putLong(key, (Long) value);
            } else if (value instanceof Float) {
                bundle.putFloat(key, (Float) value);
            } else if (value instanceof Double) {
                bundle.putDouble(key, (Double) value);
            } else if (value instanceof Boolean) {
                bundle.putBoolean(key, (Boolean) value);
            }
        }
        return bundle;
    }
}
