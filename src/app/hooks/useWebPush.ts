import { IPusher, IPusherRequest, MatrixClient } from 'matrix-js-sdk';
import { useEffect, useState } from 'react';
import { useClientConfig } from './useClientConfig';
import { useMatrixClient } from './useMatrixClient';

export type WebPushConfig = {
  appId: string;
  gatewayUrl: string;
  applicationServerKey: string;
};

export type WebPushState = 'pending' | 'ok' | 'unsupported' | 'no-config' | 'permission-needed' | 'error';
export type WebPushStatus = { state: WebPushState; detail?: string };

// Module-level status so the settings page can show why push is not armed; the
// hook swallows errors to keep the client usable, which otherwise makes a broken
// gateway indistinguishable from a working one.
let currentStatus: WebPushStatus = { state: 'pending' };
const statusListeners = new Set<(status: WebPushStatus) => void>();

const setStatus = (status: WebPushStatus) => {
  currentStatus = status;
  statusListeners.forEach((listener) => listener(status));
};

export const getWebPushStatus = (): WebPushStatus => currentStatus;

export const useWebPushStatus = (): WebPushStatus => {
  const [status, setLocalStatus] = useState<WebPushStatus>(currentStatus);
  useEffect(() => {
    statusListeners.add(setLocalStatus);
    setLocalStatus(currentStatus);
    return () => {
      statusListeners.delete(setLocalStatus);
    };
  }, []);
  return status;
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

  // A renewed subscription gets a new p256dh, i.e. a new pusher row; drop this
  // app's rows for older subscriptions so the homeserver does not keep pushing
  // into dead endpoints (and the user does not get duplicates).
  try {
    const existing = (await mx.getPushers())?.pushers ?? [];
    const superseded = existing.filter(
      (p: IPusher) => p.app_id === config.appId && p.pushkey !== json.keys?.p256dh
    );
    for (const old of superseded) {
      await mx
        .setPusher({
          kind: null,
          app_id: old.app_id,
          pushkey: old.pushkey,
        } as unknown as IPusherRequest)
        .catch(() => undefined);
    }
  } catch {
    // listing pushers is best effort; registering the current one is what matters
  }

  await mx.setPusher(pusher);
};

const subscribe = async (config: WebPushConfig): Promise<PushSubscription> => {
  const registration = await navigator.serviceWorker.ready;
  return (
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.applicationServerKey),
    }))
  );
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

  setStatus({ state: 'pending' });
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    setStatus({ state: 'permission-needed', detail: permission });
    throw new Error(`notification permission ${permission}`);
  }

  try {
    const subscription = await subscribe(config);
    await registerWebPushPusher(mx, config, subscription);
    setStatus({ state: 'ok', detail: subscription.endpoint.slice(0, 48) });
    return subscription;
  } catch (error) {
    setStatus({ state: 'error', detail: (error as Error).message });
    throw error;
  }
};

/**
 * Pushers left over from earlier experiments point at hosts this deployment no
 * longer runs (the retired ntfy relay on the docker bridge, ntfy.sh itself, or a
 * loopback address). The homeserver keeps retrying them on every event and drops
 * each attempt with "forbidden remote address", so remove them with the user's
 * own session — no access token from the user is needed for this.
 */
const isStalePusher = (pusher: IPusher, gatewayUrl: string): boolean => {
  const dataUrl = (pusher.data as Record<string, unknown> | undefined)?.url;
  const target = typeof dataUrl === 'string' ? dataUrl : pusher.url;
  // No URL at all (email pusher, app pushers) is not ours to judge.
  if (typeof target !== 'string' || target === '') return false;
  try {
    // Exactly this deployment's gateway is current; every other HTTP pusher is a
    // leftover (retired relay, ntfy topics, dead hosts) and only produces
    // "forbidden remote address" retries on the homeserver.
    return new URL(target).host !== new URL(gatewayUrl).host;
  } catch {
    return true;
  }
};

export const removeStalePushers = async (
  mx: MatrixClient,
  gatewayUrl: string
): Promise<number> => {
  const pushers = (await mx.getPushers())?.pushers ?? [];
  const stale = pushers.filter((pusher: IPusher) => isStalePusher(pusher, gatewayUrl));
  for (const pusher of stale) {
    await mx
      .setPusher({
        kind: null,
        app_id: pusher.app_id,
        pushkey: pusher.pushkey,
      } as unknown as IPusherRequest)
      .catch(() => undefined);
  }
  return stale.length;
};

/**
 * Keep the pusher in sync on every app start: the subscription can survive while
 * the pusher row on the homeserver was dropped (e.g. after a rejected pushkey).
 * Each step is guarded on its own so one failure cannot stop the others, and the
 * outcome is published for the settings page.
 */
export const useWebPush = (): void => {
  const mx = useMatrixClient();
  const { webPush } = useClientConfig();

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setStatus({ state: 'unsupported', detail: 'no service worker / PushManager' });
      return;
    }
    if (!webPush) {
      setStatus({ state: 'no-config', detail: 'config.json has no webPush block' });
      return;
    }

    let cancelled = false;
    (async () => {
      // Best effort: old pushers pointing at retired hosts.
      try {
        await removeStalePushers(mx, webPush.gatewayUrl);
      } catch {
        // listing/removing pushers must never block the subscription
      }

      if (!('Notification' in window) || Notification.permission !== 'granted') {
        setStatus({ state: 'permission-needed', detail: Notification?.permission });
        return;
      }

      try {
        const subscription = await subscribe(webPush);
        if (!subscription || cancelled) return;
        await registerWebPushPusher(mx, webPush, subscription);
        setStatus({ state: 'ok', detail: subscription.endpoint.slice(0, 48) });
      } catch (error) {
        setStatus({ state: 'error', detail: (error as Error).message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mx, webPush]);
};
