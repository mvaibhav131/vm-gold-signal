import { Badge, Group, List, Paper, Stack, Text, Title } from '@mantine/core';

import { usePageTitle } from '../hooks';

export interface PlaceholderProps {
  title: string;
  /** The phase that builds this screen for real (06_Phases_and_Setup). */
  phase: string;
  summary: string;
  /** What the screen will show, taken from 05_UI_Spec. */
  planned: readonly string[];
  testId: string;
}

/** A screen that is not built yet. It says so plainly and lists what will be here. */
export function PlaceholderPage({ title, phase, summary, planned, testId }: PlaceholderProps) {
  usePageTitle(title);
  return (
    <Stack gap="md" data-testid={testId}>
      <Group gap="sm" align="center">
        <Title order={1} size="h2">
          {title}
        </Title>
        <Badge variant="light" color="gray">
          Built in {phase}
        </Badge>
      </Group>
      <Text c="dimmed">{summary}</Text>
      <Paper withBorder p="md" radius="md">
        <Text fw={600} mb="xs">
          What will be here
        </Text>
        <List size="sm" spacing={4}>
          {planned.map((item) => (
            <List.Item key={item}>{item}</List.Item>
          ))}
        </List>
      </Paper>
    </Stack>
  );
}
