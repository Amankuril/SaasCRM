import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { io } from 'socket.io-client';
import { getAccessToken, refreshAccessToken } from './api';

type RealtimeEvent =
  | { type: 'conversation.changed'; conversationId: string }
  | { type: 'messages.changed'; conversationId: string }
  | { type: 'contacts.changed' };

/**
 * Live updates for the current workspace. The server only sends "something
 * changed" signals; we refetch the affected queries through the normal API.
 */
export function useRealtime(workspaceId: string) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const socket = io({
      path: '/socket.io',
      transports: ['websocket'],
      // Re-read the token on every (re)connect: it rotates every few minutes.
      auth: (cb) => cb({ token: getAccessToken() }),
    });

    const join = () => socket.emit('workspace:join', workspaceId);
    socket.on('connect', join);
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') {
        void refreshAccessToken().then((token) => token && socket.connect());
      }
    });

    socket.on('event', (event: RealtimeEvent) => {
      if (event.type === 'contacts.changed') {
        void queryClient.invalidateQueries({ queryKey: ['contacts', workspaceId] });
        void queryClient.invalidateQueries({ queryKey: ['tags', workspaceId] });
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ['conversations', workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ['conversation-counts', workspaceId] });
      if (event.type === 'conversation.changed') {
        void queryClient.invalidateQueries({ queryKey: ['conversation', workspaceId, event.conversationId] });
      } else {
        void queryClient.invalidateQueries({ queryKey: ['timeline', workspaceId, event.conversationId] });
        void queryClient.invalidateQueries({ queryKey: ['messages', workspaceId] });
      }
    });

    return () => {
      socket.disconnect();
    };
  }, [workspaceId, queryClient]);
}
