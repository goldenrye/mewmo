import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import { api } from "./api";

export async function clearDisplayedNotifications() {
  try {
    if (Capacitor.isNativePlatform()) {
      await PushNotifications.removeAllDeliveredNotifications();
    } else if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.getRegistration();
      const notifications = await registration?.getNotifications();
      notifications?.forEach((notification) => notification.close());
    }
  } catch {
    // Provider-accepted pushes cannot be recalled; local cleanup is best effort.
  }
}

export async function enableNotifications(vapid: string) {
  if (Capacitor.isNativePlatform()) {
    let permission = await PushNotifications.checkPermissions();
    if (permission.receive === "prompt")
      permission = await PushNotifications.requestPermissions();
    if (permission.receive !== "granted")
      throw new Error(
        "Notifications are disabled. Enable them in iPhone Settings.",
      );
    await new Promise<void>((resolve, reject) => {
      let success: { remove: () => Promise<void> } | undefined;
      let failure: { remove: () => Promise<void> } | undefined;
      const clean = () => {
        clearTimeout(timer);
        void success?.remove();
        void failure?.remove();
      };
      const timer = setTimeout(() => {
        clean();
        reject(new Error("APNs registration timed out. Please retry."));
      }, 20000);
      void (async () => {
        success = await PushNotifications.addListener(
          "registration",
          (token) => {
            void api("/devices", {
              method: "POST",
              body: JSON.stringify({ platform: "ios", token: token.value }),
            })
              .then(() => {
                clean();
                resolve();
              })
              .catch((error) => {
                clean();
                reject(error);
              });
          },
        );
        failure = await PushNotifications.addListener(
          "registrationError",
          () => {
            clean();
            reject(
              new Error(
                "APNs registration failed. Check signing and the push entitlement.",
              ),
            );
          },
        );
        await PushNotifications.register();
      })().catch((error) => {
        clean();
        reject(error);
      });
    });
    return;
  }
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error(
      "Web push is unavailable here. On iPhone, use the native app or add this site to your Home Screen.",
    );
  }
  if (!vapid)
    throw new Error("Web push keys are not configured on the server yet.");
  if ((await Notification.requestPermission()) !== "granted")
    throw new Error("Allow notifications in your browser settings.");
  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const base64 = vapid.replace(/-/g, "+").replace(/_/g, "/");
  const key = Uint8Array.from(
    atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
    (c) => c.charCodeAt(0),
  );
  const subscription =
    (await registration.pushManager.getSubscription()) ||
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    }));
  await api("/devices", {
    method: "POST",
    body: JSON.stringify({
      platform: "web",
      subscription: subscription.toJSON(),
    }),
  });
}
