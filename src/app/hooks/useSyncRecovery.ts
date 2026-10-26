import { ClientEvent, MatrixClient, SyncState } from 'matrix-js-sdk';
import { useEffect, useRef } from 'react';
import { startClient } from '../../client/initMatrix';

/** /sync long-poll timeout the client asks the server for. */
const SYNC_TIMEOUT_MS = 30 * 1000;
/**
 * A visible client that has not processed a sync response for this long no longer
 * has a request of its own: the one it sent was suspended or dropped and will
 * never settle.
 */
const HUNG_AFTER_MS = SYNC_TIMEOUT_MS + 15 * 1000;
const WATCHDOG_INTERVAL_MS = 10 * 1000;
const RESTART_COOLDOWN_MS = 30 * 1000;

/**
 * Keeps sync alive across the app being backgrounded.
 *
 * An installed PWA loses its /sync long-poll when the phone switches away from it;
 * matrix-js-sdk only re-probes on its own backoff timer or on a browser `online`
 * event, and neither happens on return from the background: timers are throttled
 * while hidden (up to once a minute) and the network never actually dropped. The
 * result is a client that sits on "Connecting..." until the user pokes it.
 *
 * So: probe the connection as soon as the page is visible again, and if the state
 * still says "syncing" long after the last response, restart the sync loop — a
 * frozen page comes back with a request that will never settle, and only a new
 * loop frees it.
 */
export const useSyncRecovery = (mx?: MatrixClient): void => {
  const lastSyncAt = useRef(Date.now());
  const lastRestartAt = useRef(0);

  useEffect(() => {
    if (!mx) return undefined;

    const onSync = () => {
      lastSyncAt.current = Date.now();
    };
    mx.on(ClientEvent.Sync, onSync);

    const restartSync = async () => {
      const now = Date.now();
      if (now - lastRestartAt.current < RESTART_COOLDOWN_MS) return;
      lastRestartAt.current = now;
      lastSyncAt.current = now;
      mx.stopClient();
      try {
        await startClient(mx);
      } catch {
        // startClient reports failures through the sync state; the watchdog retries.
      }
    };

    const kick = () => {
      if (document.visibilityState !== 'visible') return;
      mx.retryImmediately();

      const state = mx.getSyncState();
      const waitingOnRequest =
        state === SyncState.Syncing || state === SyncState.Catchup || state === null;
      if (waitingOnRequest && Date.now() - lastSyncAt.current > HUNG_AFTER_MS) {
        restartSync();
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') kick();
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', kick);
    window.addEventListener('online', kick);
    window.addEventListener('pageshow', kick);
    const watchdog = window.setInterval(kick, WATCHDOG_INTERVAL_MS);

    return () => {
      mx.removeListener(ClientEvent.Sync, onSync);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', kick);
      window.removeEventListener('online', kick);
      window.removeEventListener('pageshow', kick);
      window.clearInterval(watchdog);
    };
  }, [mx]);
};
