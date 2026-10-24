import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Settings, SettingsPatch, StrategyInfo, StrategyPatch } from '@vmgs/contracts';
import type { StrategyKey } from '@vmgs/core';

import { useApi } from '../api/context';
import { KEYS } from './queries';
import { mergeSettingsPatch } from './settingsPatch';

/**
 * Saves a change of the settings. The screen shows the change at once and puts the old value back
 * if the API refuses it. The alert switch of a strategy is part of the settings, so the strategy
 * list is reloaded too.
 */
export function useUpdateSettings() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => api.updateSettings(patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: KEYS.settings });
      const previous = queryClient.getQueryData<Settings>(KEYS.settings);
      if (previous) queryClient.setQueryData(KEYS.settings, mergeSettingsPatch(previous, patch));
      return { previous };
    },
    onError: (_error, _patch, context) => {
      if (context?.previous) queryClient.setQueryData(KEYS.settings, context.previous);
    },
    onSuccess: (settings) => {
      queryClient.setQueryData(KEYS.settings, settings);
      void queryClient.invalidateQueries({ queryKey: KEYS.strategies });
    },
  });
}

/** Saves the enable switch or the alert switch of one strategy, shown at once like a change of the settings. */
export function useUpdateStrategy() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ key, patch }: { key: StrategyKey; patch: StrategyPatch }) =>
      api.updateStrategy(key, patch),
    onMutate: async ({ key, patch }) => {
      await queryClient.cancelQueries({ queryKey: KEYS.strategies });
      const previous = queryClient.getQueryData<StrategyInfo[]>(KEYS.strategies);
      if (previous) {
        queryClient.setQueryData<StrategyInfo[]>(
          KEYS.strategies,
          previous.map((strategy) =>
            strategy.key === key
              ? {
                  ...strategy,
                  enabled: patch.enabled ?? strategy.enabled,
                  alerts: patch.alerts ?? strategy.alerts,
                }
              : strategy,
          ),
        );
      }
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(KEYS.strategies, context.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: KEYS.strategies });
      void queryClient.invalidateQueries({ queryKey: KEYS.settings });
    },
  });
}

/** Pause and resume of the engine: both reload the snapshot, which carries the engine state. */
export function useEngineControls() {
  const api = useApi();
  const queryClient = useQueryClient();
  const reload = () => queryClient.invalidateQueries({ queryKey: KEYS.snapshot });
  const pause = useMutation({
    mutationFn: (minutes: number | undefined) =>
      api.pauseEngine(minutes === undefined ? {} : { minutes }),
    onSuccess: reload,
  });
  const resume = useMutation({ mutationFn: () => api.resumeEngine(), onSuccess: reload });
  return { pause, resume };
}
