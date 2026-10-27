import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { io } from 'socket.io-client';
import { getAccessToken, refreshAccessToken } from './api';

type RealtimeEvent =
  | { type: 'conversation.changed'; conversationId: string }
  | { type: 'messages.changed'; conversationId: string }
  | { type: 'contacts.changed' }
  | { type: 'tasks.changed' }
  | { type: 'appointments.changed' };

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

    // Signals sent while we were disconnected are lost: refetch everything once on
    // reconnect, and poll while the socket is down so the inbox never goes stale.
    const refreshAll = () => {
      for (const key of ['conversations', 'conversation-counts', 'conversation', 'timeline', 'messages', 'contacts']) {
        void queryClient.invalidateQueries({ queryKey: [key, workspaceId] });
      }
    };
    let poll: ReturnType<typeof setInterval> | null = null;
    let wasConnected = false;
    const stopPolling = () => {
      if (poll) clearInterval(poll);
      poll = null;
    };
    const startPolling = () => {
      poll ??= setInterval(refreshAll, 15_000);
    };
    // Until the first connect succeeds, keep the inbox fresh by polling.
    const firstConnectTimer = setTimeout(() => !socket.connected && startPolling(), 5_000);

    const join = () => {
      socket.emit('workspace:join', workspaceId);
      stopPolling();
      if (wasConnected) refreshAll();
      wasConnected = true;
    };
    socket.on('connect', join);
    socket.on('disconnect', startPolling);
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') {
        void refreshAccessToken().then((token) => token && socket.connect());
      }
    });

    socket.on('event', (event: RealtimeEvent) => {
      if (event.type === 'contacts.changed') {
        void queryClient.invalidateQueries({ queryKey: ['contacts', workspaceId] });
        void queryClient.invalidateQueries({ queryKey: ['tags', workspaceId] });
        void queryClient.invalidateQueries({ queryKey: ['audience', workspaceId] });
        return;
      }
      if (event.type === 'tasks.changed') {
        void queryClient.invalidateQueries({ queryKey: ['tasks', workspaceId] });
        return;
      }
      if (event.type === 'appointments.changed') {
        void queryClient.invalidateQueries({ queryKey: ['appointments', workspaceId] });
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
      clearTimeout(firstConnectTimer);
      stopPolling();
      socket.disconnect();
    };
  }, [workspaceId, queryClient]);
}
