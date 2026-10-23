import { Button, Group, Modal, Radio, Stack, Text } from '@mantine/core';
import { useState } from 'react';

const OPTIONS = [
  { value: '30', label: '30 minutes' },
  { value: '60', label: '1 hour' },
  { value: '240', label: '4 hours' },
  { value: 'open', label: 'Until I resume' },
] as const;

/**
 * Pausing is a risky action, so it asks first (05_UI_Spec section 8). While paused the engine
 * produces no new signal; recording and tracking of open signals go on.
 */
export function PauseDialog({
  opened,
  onClose,
  onConfirm,
  loading,
}: {
  opened: boolean;
  onClose: () => void;
  onConfirm: (minutes: number | undefined) => void;
  loading: boolean;
}) {
  const [choice, setChoice] = useState<string>('60');

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Pause the engine?"
      centered
      closeButtonProps={{ 'aria-label': 'Close' }}
      transitionProps={{ duration: 0 }}
    >
      <Stack gap="md" data-testid="pause-dialog">
        <Text size="sm">
          While paused, no new signal is produced and no signal alert is sent. Data keeps being
          recorded and open signals keep being tracked. The system never pauses itself.
        </Text>
        <Radio.Group value={choice} onChange={setChoice} label="Pause for">
          <Stack gap="xs" mt="xs">
            {OPTIONS.map((option) => (
              <Radio key={option.value} value={option.value} label={option.label} />
            ))}
          </Stack>
        </Radio.Group>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            color="warning"
            loading={loading}
            data-testid="pause-confirm"
            onClick={() => {
              onConfirm(choice === 'open' ? undefined : Number(choice));
            }}
          >
            Pause engine
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
