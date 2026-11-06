self.addEventListener("push", (event) => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      // A unique reminder tag permits retry deduplication without replacing other reminders.
      tag: data.reminder_id,
      data: { itemId: data.item_id },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = `/?item=${encodeURIComponent(event.notification.data.itemId)}`;
  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (windows) => {
        const existing = windows.find(
          (window) => new URL(window.url).origin === self.location.origin,
        );
        if (existing) {
          await existing.navigate(path);
          return existing.focus();
        }
        return clients.openWindow(path);
      }),
  );
});
