import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.jpi.mewmo",
  appName: "Mewmo",
  webDir: "dist",
  // Keychain bridge calls carry session tokens, including during development.
  loggingBehavior: "none",
  ios: { contentInset: "never" },
  plugins: {
    PushNotifications: { presentationOptions: ["badge", "sound", "alert"] },
  },
};

export default config;
