import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.jpi.mewmo",
  appName: "Mewmo",
  webDir: "dist",
  backgroundColor: "#f8f6f2",
  // Keychain bridge calls carry session tokens, including during development.
  loggingBehavior: "none",
  ios: { contentInset: "never" },
  plugins: {
    PushNotifications: { presentationOptions: ["badge", "sound", "alert"] },
  },
};

export default config;
