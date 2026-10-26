import { useAtomValue } from 'jotai';
import { selectAtom } from 'jotai/utils';
import { useCallback } from 'react';
import {
  IRoomIdToTypingMembers,
  TypingReceipt,
  roomIdToTypingMembersAtom,
} from '../state/typingMembers';

// `ts` is bookkeeping for receipt expiry: a refresh of an unchanged typing set must not
// re-render the typing bar, so the comparison only looks at who is typing.
const typingReceiptEqual = (a: TypingReceipt, b: TypingReceipt): boolean => a.userId === b.userId;

const equalTypingMembers = (x: TypingReceipt[], y: TypingReceipt[]): boolean => {
  if (x.length !== y.length) return false;
  return x.every((a, i) => typingReceiptEqual(a, y[i]));
};

export const useRoomTypingMember = (roomId: string) => {
  const selector = useCallback(
    (roomToTyping: IRoomIdToTypingMembers) => roomToTyping.get(roomId) ?? [],
    [roomId]
  );

  const typing = useAtomValue(selectAtom(roomIdToTypingMembersAtom, selector, equalTypingMembers));
  return typing;
};
