import { IPusherRequest, MatrixClient } from 'matrix-js-sdk';
import { useEffect } from 'react';
import { useClientConfig } from './useClientConfig';
import { useMatrixClient } from './useMatrixClient';

export type WebPushConfig = {
  appId: string;
  gatewayUrl: string;
  applicationServerKey: string;
};

const urlBase64ToUint8Array = (base64: string): Uint8Array => {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
};

/**
 * Register this browser as a Matrix pusher for a Web Push endpoint.
 *
 * Sygnal (the gateway) wants the p256dh key as the pushkey and the endpoint plus
 * the auth secret in `data`. `append: true` matters: a single origin has one push
 * subscription, so with several accounts in Cinny the same p256dh is reused and
 * append keeps the other accounts' pushers alive.
 */
export const registerWebPushPusher = async (
  mx: MatrixClient,
  config: WebPushConfig,
  subscription: PushSubscription
): Promise<void> => {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error('incomplete push subscription');
  }

  const pusher = {
    kind: 'http',
    app_id: config.appId,
    pushkey: json.keys.p256dh,
    url: config.gatewayUrl,
    app_display_name: 'Cinny',
    device_display_name: 'Cinny Web',
    lang: navigator.language?.split('-')[0] || 'en',
    data: {
      // Tuwunel (Conduit lineage) additionally requires data.url on HTTP pushers,
      // on top of the spec's top-level url; Sygnal ignores it.
      url: config.gatewayUrl,
      endpoint: json.endpoint,
      auth: json.keys.auth,
      // Suppress count-only pushes: without an event id the service worker would
      // have nothing to show and the browser would display its own placeholder.
      events_only: true,
    },
    append: true,
  } as unknown as IPusherRequest;

  await mx.setPusher(pusher);
};

/**
 * User-gesture entry point: ask for the permission and subscribe in one step
 * (some browsers only offer a single permission prompt per site).
 */
export const enableWebPush = async (
  mx: MatrixClient,
  config: WebPushConfig
): Promise<PushSubscription> => {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('Web Push is not supported by this browser');
  }
  if (!('Notification' in window)) throw new Error('notifications are not supported');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(`notification permission ${permission}`);

  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.applicationServerKey),
    }));

  await registerWebPushPusher(mx, config, subscription);
  return subscription;
};

/**
 * Keep the pusher in sync on every app start: the subscription can survive while
 * the pusher row on the homeserver was dropped (e.g. after a rejected pushkey).
 */
export const useWebPush = (): void => {
  const mx = useMatrixClient();
  const { webPush } = useClientConfig();

  useEffect(() => {
    if (!webPush || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    let cancelled = false;
    (async () => {
      try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (!subscription || cancelled) return;
        await registerWebPushPusher(mx, webPush, subscription);
      } catch {
        // A gateway that is down must not break the client.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mx, webPush]);
};
