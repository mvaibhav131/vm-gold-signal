import { Button, Group, Select, SimpleGrid, TextInput } from '@mantine/core';

import { FILTER_LABELS, FILTER_OPTIONS, SELECT_FILTERS, type ParsedFilters } from './filters';

/**
 * The filters of 05_UI_Spec section 6.1: a date range and one choice each for result, strategy,
 * side, session, regime, failure cause and grade. They live in the address bar, so a filtered list
 * can be reloaded, shared and left with the back button; the page owns that and passes `onParam`.
 */
export function HistoryFilterBar({
  parsed,
  onParam,
  onReset,
}: {
  parsed: ParsedFilters;
  onParam: (name: string, value: string | null) => void;
  onReset: () => void;
}) {
  const { values, dateError, active } = parsed;
  return (
    <form
      aria-label="Signal filters"
      data-testid="history-filters"
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <SimpleGrid cols={{ base: 2, sm: 3, md: 5 }} spacing="sm" verticalSpacing="sm">
        <TextInput
          type="date"
          label={FILTER_LABELS.from}
          value={values.from}
          onChange={(event) => {
            onParam('from', event.currentTarget.value);
          }}
          data-testid="history-filter-from"
        />
        <TextInput
          type="date"
          label={FILTER_LABELS.to}
          value={values.to}
          error={dateError ? 'The end date is before the start date' : undefined}
          onChange={(event) => {
            onParam('to', event.currentTarget.value);
          }}
          data-testid="history-filter-to"
        />
        {SELECT_FILTERS.map((name) => (
          <Select
            key={name}
            label={FILTER_LABELS[name]}
            placeholder="All"
            data={[...FILTER_OPTIONS[name]]}
            value={values[name] === '' ? null : values[name]}
            onChange={(value) => {
              onParam(name, value);
            }}
            clearable
            allowDeselect
            // the longest list (9 causes) fits, so the menu never needs a scroll bar of its own
            maxDropdownHeight={380}
            comboboxProps={{ withinPortal: true }}
            data-testid={`history-filter-${name}`}
          />
        ))}
      </SimpleGrid>
      <Group mt="sm" justify="flex-end">
        <Button
          variant="subtle"
          size="xs"
          disabled={active === 0 && !dateError}
          onClick={onReset}
          data-testid="history-filter-reset"
        >
          Clear filters
        </Button>
      </Group>
    </form>
  );
}
