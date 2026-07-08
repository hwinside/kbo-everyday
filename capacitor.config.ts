import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "fan.keubo.app",
  appName: "크보팬",
  webDir: "out",
  server: {
    url: "https://keubo.fan",
    cleartext: false,
  },
  ios: {
    scheme: "크보팬",
  },
  android: {
    allowMixedContent: false,
  },
  plugins: {
    FirebaseMessaging: {
      presentationOptions: ["alert", "badge", "sound"],
    },
  },
};

export default config;
