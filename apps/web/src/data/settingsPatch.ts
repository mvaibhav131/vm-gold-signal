import type { Settings, SettingsPatch } from '@vmgs/contracts';

/**
 * What a `PATCH /settings` does to the settings: a value that is sent replaces the stored one, the
 * rest stays. A list (the alert kinds) is replaced as a whole; the switches of the strategies and
 * of the topics are changed one by one. The screen uses it to show a change at once, before the
 * API has answered; the answer of the API then replaces it.
 */
export function mergeSettingsPatch(settings: Settings, patch: SettingsPatch): Settings {
  const telegram = patch.alerts?.telegram;
  const webpush = patch.alerts?.webpush;
  const gates = patch.advisoryGates;
  const news = patch.newsAlerts;
  return {
    displayTz: patch.displayTz ?? settings.displayTz,
    locale: patch.locale ?? settings.locale,
    alerts: {
      telegram: {
        enabled: telegram?.enabled ?? settings.alerts.telegram.enabled,
        minGrade: telegram?.minGrade ?? settings.alerts.telegram.minGrade,
        kinds: telegram?.kinds ?? settings.alerts.telegram.kinds,
      },
      webpush: {
        enabled: webpush?.enabled ?? settings.alerts.webpush.enabled,
        minGrade: webpush?.minGrade ?? settings.alerts.webpush.minGrade,
      },
    },
    advisoryGates: {
      newsWindow: gates?.newsWindow ?? settings.advisoryGates.newsWindow,
      rollover: gates?.rollover ?? settings.advisoryGates.rollover,
      offHours: gates?.offHours ?? settings.advisoryGates.offHours,
      nearLevel: gates?.nearLevel ?? settings.advisoryGates.nearLevel,
    },
    strategyAlerts: { ...settings.strategyAlerts, ...patch.strategyAlerts },
    newsAlerts: {
      minImpact: news?.minImpact ?? settings.newsAlerts.minImpact,
      topics: { ...settings.newsAlerts.topics, ...news?.topics },
      marketMoves: news?.marketMoves ?? settings.newsAlerts.marketMoves,
    },
  };
}
