import { Select, Stack, Text } from '@mantine/core';

import { QueryBoundary, Section } from '../components/page';
import { useUpdateSettings } from '../data/mutations';
import { useSettings } from '../data/queries';
import { formatDateTime, zoneLabel } from '../format/time';
import { useNow } from '../hooks';
import { timeZoneMenuSize, timeZoneOptions } from './timezones';

/**
 * The display time zone (05_UI_Spec section 1: every time on screen follows it, with UTC in the
 * tooltip). The numbers have no setting: prices and spreads always show 3 decimals and R values 2
 * (owner decision of 2026-10-23).
 */
export function DisplayTab() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const nowMs = useNow(1000);
  return (
    <QueryBoundary query={settings} what="the display settings">
      {(data) => (
        <Stack gap="md">
          <Section
            title="Time zone"
            description="Every time in the app is shown in this zone, with the UTC time in the tooltip. Months in the statistics follow it too."
          >
            <Stack gap="sm">
              <Select
                label="Time zone"
                description="The common zones are listed first. Type a city or a region to find any other."
                data={timeZoneOptions(data.displayTz)}
                value={data.displayTz}
                searchable
                limit={timeZoneMenuSize(data.displayTz)}
                maxDropdownHeight={440}
                nothingFoundMessage="No time zone with this name"
                onChange={(value) => {
                  if (value !== null && value !== data.displayTz) {
                    update.mutate({ displayTz: value });
                  }
                }}
                allowDeselect={false}
                maw={360}
                data-testid="display-timezone"
              />
              <Text size="sm" data-testid="display-now">
                Now: {formatDateTime(new Date(nowMs).toISOString(), data.displayTz)} (
                {zoneLabel(data.displayTz, nowMs)})
              </Text>
              {update.isError && (
                <Text role="alert" className="text-negative" size="sm">
                  The time zone could not be saved. Nothing was changed.
                </Text>
              )}
            </Stack>
          </Section>

          <Section title="Numbers">
            <Text size="sm" data-testid="display-numbers">
              Prices and spreads are shown with 3 decimals, as they are stored. R values are shown
              with 2 decimals, and a percentage is a whole number. These do not change.
            </Text>
          </Section>
        </Stack>
      )}
    </QueryBoundary>
  );
}
