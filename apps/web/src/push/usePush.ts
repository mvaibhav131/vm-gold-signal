import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApi } from '../api/context';
import { KEYS } from '../data/queries';
import { usePushEnv } from './env';
import { urlBase64ToBytes } from './key';
import { PushProblem, pushStateOf } from './state';

/**
 * Web Push on this device: what can be said about it, and the three things the owner can do (subscribe, unsubscribe, send a
 * test). The server knows the devices and the browser knows its own subscription; both are looked at, because they can part
 * (a push service that says a subscription is gone makes the server forget it).
 */
export function usePushDevice() {
  const api = useApi();
  const env = usePushEnv();
  const queryClient = useQueryClient();
  const live = api.kind === 'live';

  const status = useQuery({
    queryKey: KEYS.pushStatus,
    queryFn: () => api.getPushStatus(),
    enabled: live,
    retry: false,
  });
  const device = useQuery({
    queryKey: KEYS.pushDevice,
    queryFn: async () => (await env.current()) !== null,
    enabled: live && env.supported(),
    retry: false,
  });

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: KEYS.pushStatus }),
      queryClient.invalidateQueries({ queryKey: KEYS.pushDevice }),
    ]);
  };

  const enable = useMutation({
    mutationFn: async () => {
      if ((await env.requestPermission()) !== 'granted') {
        throw new PushProblem('blocked', 'notifications were not allowed');
      }
      const { publicKey } = await api.getPushStatus();
      if (publicKey === null) throw new PushProblem('not-set-up', 'the server has no VAPID key');
      const subscription = await env.subscribe(urlBase64ToBytes(publicKey));
      const keys = subscription.keys();
      if (keys === null) {
        await subscription.unsubscribe();
        throw new PushProblem('no-keys', 'the browser gave no keys');
      }
      try {
        await api.subscribePush({
          endpoint: subscription.endpoint,
          keys,
          userAgent: navigator.userAgent.slice(0, 300),
        });
      } catch (error) {
        // a subscription that the server did not take would leave the two apart: the browser lets it go too
        await subscription.unsubscribe().catch(() => false);
        throw error;
      }
    },
    onSettled: refresh,
  });

  const disable = useMutation({
    mutationFn: async () => {
      const subscription = await env.current();
      if (subscription === null) return;
      // the server first: if it cannot be reached the device stays subscribed on both sides, and the owner can try again
      await api.unsubscribePush({ endpoint: subscription.endpoint });
      await subscription.unsubscribe();
    },
    onSettled: refresh,
  });

  const facts = {
    apiKind: api.kind,
    status: status.isError ? null : status.data,
    supported: env.supported(),
    needsInstall: env.needsInstall(),
    permission: env.permission(),
    subscribed: device.data,
  };
  const state = pushStateOf(facts);
  return { state, enable, disable, canTest: (status.data?.devices ?? 0) > 0 };
}
