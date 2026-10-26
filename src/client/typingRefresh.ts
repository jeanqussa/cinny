import { EventType, MatrixEvent, Room } from 'matrix-js-sdk';
import { emitTypingRefresh } from '../app/state/typingMembers';

let installed = false;

/**
 * Forward every `m.typing` delivery to the typing store, refreshes included.
 *
 * matrix-js-sdk reports typing through `RoomMemberEvent.Typing`, which
 * `RoomMember.setTypingEvent` emits only when the boolean changes. Senders refresh a
 * typing notification every few seconds (Cinny every 5s, Element ~10s, the Hermes
 * gateway every 2s) and the flag stays `true` throughout, so only the first event of an
 * episode ever reaches the client — long typing then had to expire on a single local
 * timeout, which hid people who were still typing. `Room.addEphemeralEvents` is called
 * for each delivery and knows the room, while the event payload carries no room id, so
 * wrap that call to get both halves.
 */
export const installTypingRefreshHook = (): void => {
  if (installed) return;
  installed = true;

  const { addEphemeralEvents } = Room.prototype;
  Room.prototype.addEphemeralEvents = function addEphemeralEventsWithTyping(
    this: Room,
    events: MatrixEvent[]
  ): void {
    addEphemeralEvents.call(this, events);

    events.forEach((event) => {
      if (event.getType() !== EventType.Typing) return;
      const userIds = event.getContent<{ user_ids?: unknown }>()?.user_ids;
      if (!Array.isArray(userIds)) return;
      emitTypingRefresh(
        this.roomId,
        userIds.filter((userId): userId is string => typeof userId === 'string')
      );
    });
  };
};
