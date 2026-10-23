import { Badge, Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';

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
    <Stack gap="lg" data-testid={testId}>
      <Stack gap={6}>
        <Group gap="sm" align="center">
          <Title order={1} size="h2">
            {title}
          </Title>
          <Badge variant="light" color="gold">
            Built in {phase}
          </Badge>
        </Group>
        <Text c="dimmed" maw={720}>
          {summary}
        </Text>
      </Stack>
      <Stack gap="sm">
        <Text fw={600}>What will be here</Text>
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
          {planned.map((item, index) => (
            <div key={item} className="plan-card">
              <span className="plan-number" aria-hidden="true">
                {index + 1}
              </span>
              <Text size="sm">{item}</Text>
            </div>
          ))}
        </SimpleGrid>
      </Stack>
    </Stack>
  );
}
