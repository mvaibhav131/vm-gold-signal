import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import type { ReactNode } from 'react';

/**
 * Risky actions (disable a strategy, revoke a session) ask first (05_UI_Spec section 8). The
 * dialog says what will happen and how to undo it; the safe button is the one that cancels.
 */
export function ConfirmDialog({
  opened,
  title,
  confirmLabel,
  onConfirm,
  onClose,
  loading = false,
  testId,
  children,
}: {
  opened: boolean;
  title: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  loading?: boolean;
  /** The test id of the confirm button. */
  testId: string;
  children: ReactNode;
}) {
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={title}
      centered
      closeButtonProps={{ 'aria-label': 'Close' }}
      transitionProps={{ duration: 0 }}
    >
      <Stack gap="md">
        <Text size="sm" component="div">
          {children}
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button color="warning" loading={loading} onClick={onConfirm} data-testid={testId}>
            {confirmLabel}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
