import produce from 'immer';
import { atom, useSetAtom } from 'jotai';
import { MatrixClient, RoomMemberEvent, RoomMemberEventHandlerMap } from 'matrix-js-sdk';
import { useEffect } from 'react';
import { useSetting } from './hooks/settings';
import { settingsAtom } from './settings';

export const TYPING_TIMEOUT_MS = 5000; // 5 seconds
/**
 * How long a *received* typing notification keeps a member visible. The refresh interval
 * belongs to the sender (Cinny re-sends every 5s, Element ~10s, the Hermes gateway every
 * 2s), and the timeout they ask the server for is usually 30s, so expiring on our own 5s
 * send interval hides people who are still typing.
 */
export const TYPING_RECEIVE_TIMEOUT_MS = 30000; // 30 seconds

export type TypingReceipt = {
  userId: string;
  ts: number;
};
export type IRoomIdToTypingMembers = Map<string, TypingReceipt[]>;

type TypingMemberPutAction = {
  type: 'PUT';
  roomId: string;
  userId: string;
  ts: number;
};
type TypingMemberDeleteAction = {
  type: 'DELETE';
  roomId: string;
  userId: string;
};
/**
 * The full typing set of a room, as delivered by an `m.typing` event. Every refresh of a
 * typing notification produces one of these, which is the only way to keep a long typing
 * episode visible (see typingRefresh.ts).
 */
type TypingMemberRefreshAction = {
  type: 'REFRESH';
  roomId: string;
  userIds: string[];
  ts: number;
};
export type IRoomIdToTypingMembersAction =
  | TypingMemberPutAction
  | TypingMemberDeleteAction
  | TypingMemberRefreshAction;

const baseRoomIdToTypingMembersAtom = atom<IRoomIdToTypingMembers>(new Map());

const putTypingMember = (
  roomToMembers: IRoomIdToTypingMembers,
  action: TypingMemberPutAction
): IRoomIdToTypingMembers => {
  let typingMembers = roomToMembers.get(action.roomId) ?? [];

  typingMembers = typingMembers.filter((receipt) => receipt.userId !== action.userId);
  typingMembers.push({
    userId: action.userId,
    ts: action.ts,
  });
  roomToMembers.set(action.roomId, typingMembers);
  return roomToMembers;
};

const deleteTypingMember = (
  roomToMembers: IRoomIdToTypingMembers,
  action: TypingMemberDeleteAction
): IRoomIdToTypingMembers => {
  let typingMembers = roomToMembers.get(action.roomId) ?? [];

  typingMembers = typingMembers.filter((receipt) => receipt.userId !== action.userId);
  if (typingMembers.length === 0) {
    roomToMembers.delete(action.roomId);
  } else {
    roomToMembers.set(action.roomId, typingMembers);
  }
  return roomToMembers;
};

const timeoutReceipt = (
  roomToMembers: IRoomIdToTypingMembers,
  roomId: string,
  userId: string,
  timeout: number
): boolean | undefined => {
  const typingMembers = roomToMembers.get(roomId) ?? [];

  const target = typingMembers.find((receipt) => receipt.userId === userId);
  if (!target) return undefined;

  return Date.now() - target.ts >= timeout;
};

/**
 * Listeners for raw `m.typing` deliveries, including refreshes of an unchanged typing set.
 * See client/typingRefresh.ts for where these come from.
 */
type TypingRefreshListener = (roomId: string, userIds: string[]) => void;
const typingRefreshListeners = new Set<TypingRefreshListener>();

export const onTypingRefresh = (listener: TypingRefreshListener): (() => void) => {
  typingRefreshListeners.add(listener);
  return () => {
    typingRefreshListeners.delete(listener);
  };
};

export const emitTypingRefresh = (roomId: string, userIds: string[]): void => {
  typingRefreshListeners.forEach((listener) => listener(roomId, userIds));
};

export const roomIdToTypingMembersAtom = atom<
  IRoomIdToTypingMembers,
  [IRoomIdToTypingMembersAction],
  undefined
>(
  (get) => get(baseRoomIdToTypingMembersAtom),
  (get, set, action) => {
    const rToTyping = get(baseRoomIdToTypingMembersAtom);

    // A member disappears on its own only if nothing refreshed it in the meantime, so
    // every receipt gets its own expiry that newer receipts of the same member defeat.
    const scheduleExpiry = (roomId: string, userId: string) => {
      setTimeout(() => {
        const timeout = timeoutReceipt(
          get(baseRoomIdToTypingMembersAtom),
          roomId,
          userId,
          TYPING_RECEIVE_TIMEOUT_MS
        );
        if (timeout) {
          set(
            baseRoomIdToTypingMembersAtom,
            produce(get(baseRoomIdToTypingMembersAtom), (draft) =>
              deleteTypingMember(draft, {
                type: 'DELETE',
                roomId,
                userId,
              })
            )
          );
        }
      }, TYPING_RECEIVE_TIMEOUT_MS);
    };

    if (action.type === 'PUT') {
      set(
        baseRoomIdToTypingMembersAtom,
        produce(rToTyping, (draft) => putTypingMember(draft, action))
      );

      // remove typing receipt after some timeout
      // to prevent stuck typing members
      scheduleExpiry(action.roomId, action.userId);
    }

    if (action.type === 'REFRESH') {
      const { roomId, userIds, ts } = action;
      const known = rToTyping.get(roomId) ?? [];
      const gone = known.filter((receipt) => !userIds.includes(receipt.userId));

      if (gone.length > 0 || userIds.length > 0) {
        set(
          baseRoomIdToTypingMembersAtom,
          produce(rToTyping, (draft) => {
            gone.forEach((receipt) =>
              deleteTypingMember(draft, { type: 'DELETE', roomId, userId: receipt.userId })
            );
            userIds.forEach((userId) =>
              putTypingMember(draft, { type: 'PUT', roomId, userId, ts })
            );
          })
        );
        userIds.forEach((userId) => scheduleExpiry(roomId, userId));
      }
    }

    if (
      action.type === 'DELETE' &&
      rToTyping.get(action.roomId)?.find((receipt) => receipt.userId === action.userId)
    ) {
      set(
        baseRoomIdToTypingMembersAtom,
        produce(rToTyping, (draft) => deleteTypingMember(draft, action))
      );
    }
  }
);

export const useBindRoomIdToTypingMembersAtom = (
  mx: MatrixClient,
  typingMembersAtom: typeof roomIdToTypingMembersAtom
) => {
  const setTypingMembers = useSetAtom(typingMembersAtom);
  const [hideActivity] = useSetting(settingsAtom, 'hideActivity');

  useEffect(() => {
    const handleTypingEvent: RoomMemberEventHandlerMap[RoomMemberEvent.Typing] = (
      event,
      member
    ) => {
      if (hideActivity) {
        return;
      }
      setTypingMembers({
        type: member.typing ? 'PUT' : 'DELETE',
        roomId: member.roomId,
        userId: member.userId,
        ts: Date.now(),
      });
    };

    // RoomMemberEvent.Typing only fires when the flag *changes*, so a sender refreshing
    // its typing notification every few seconds is invisible to it.
    const stopTypingRefresh = onTypingRefresh((roomId, userIds) => {
      if (hideActivity) {
        return;
      }
      setTypingMembers({ type: 'REFRESH', roomId, userIds, ts: Date.now() });
    });

    mx.on(RoomMemberEvent.Typing, handleTypingEvent);
    return () => {
      stopTypingRefresh();
      mx.removeListener(RoomMemberEvent.Typing, handleTypingEvent);
    };
  }, [mx, setTypingMembers, hideActivity]);
};
