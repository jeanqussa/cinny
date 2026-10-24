import { MatrixClient, NotificationCountType, ReceiptType } from 'matrix-js-sdk';

/**
 * Mark a room as read.
 *
 * The badge in the room list renders the unread counts the homeserver reported
 * through /sync, cached on the `Room` object. A homeserver only re-sends a count
 * when it changes, so one stale value (dropped sync, a receipt that never made
 * it out, a server restart that invalidated the sync position) can keep a badge
 * on screen indefinitely — and the previous version of this function also
 * returned silently when the room's timeline was not loaded, which is exactly
 * the state a room is in when "Mark as read" is used from the room list.
 *
 * So: clear the local counters immediately (that is what the UI renders) and
 * then send the receipt that makes the server agree, retried once. If the
 * timeline has not been loaded yet, page it in first so there is an event to
 * receipt against.
 */
export async function markAsRead(
  mx: MatrixClient,
  roomId: string,
  privateReceipt: boolean
): Promise<void> {
  const room = mx.getRoom(roomId);
  if (!room) return;

  room.setUnreadNotificationCount(NotificationCountType.Total, 0);
  room.setUnreadNotificationCount(NotificationCountType.Highlight, 0);

  const userId = mx.getUserId();
  if (!userId) return;

  const latestValidEvent = () => {
    const timeline = room.getLiveTimeline().getEvents();
    const readEventId = room.getEventReadUpTo(userId);
    for (let i = timeline.length - 1; i >= 0; i -= 1) {
      const event = timeline[i];
      if (event.getId() === readEventId) return undefined;
      if (!event.isSending()) return event;
    }
    return undefined;
  };

  let latestEvent = latestValidEvent();
  if (!latestEvent) {
    // Room never opened in this session: page the timeline in so there is an
    // event id to receipt against, otherwise the server keeps its old count.
    try {
      await mx.scrollback(room, 1);
      latestEvent = latestValidEvent();
    } catch {
      latestEvent = undefined;
    }
  }
  if (!latestEvent) return;

  const send = () =>
    mx.sendReadReceipt(
      latestEvent!,
      privateReceipt ? ReceiptType.ReadPrivate : ReceiptType.Read
    );

  try {
    await send();
  } catch {
    // One retry: a receipt aborted mid-request (app backgrounded) is the usual
    // reason a badge reappears after a reload.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await send().catch(() => undefined);
  }
}
